import { JsonRpcProvider } from "@ethersproject/providers";
import { EntityID, ComponentValue } from "@latticexyz/recs";
import { to256BitString, awaitPromise, range, sleep } from "@latticexyz/utils";
import { GrpcWebFetchTransport } from "@protobuf-ts/grpcweb-transport";
import { BytesLike, Contract, BigNumber } from "ethers";
import { Observable, map, concatMap, of, from } from "rxjs";
import { createDecoder } from "../createDecoder";
import { createTopics } from "../createTopics";
import { fetchEventsInBlockRange } from "../networkUtils";
import { ECSStateReply } from "@latticexyz/services/protobuf/ts/ecs-snapshot/ecs-snapshot";
import { ECSStateSnapshotServiceClient } from "@latticexyz/services/protobuf/ts/ecs-snapshot/ecs-snapshot.client";
import { ECSStreamServiceClient } from "@latticexyz/services/protobuf/ts/ecs-stream/ecs-stream.client";
import { NetworkComponentUpdate, ContractConfig } from "../types";
import { CacheStore, createCacheStore, storeEvent } from "./CacheStore";
import { abi as ComponentAbi } from "@latticexyz/solecs/abi/Component.json";
import { abi as WorldAbi } from "@latticexyz/solecs/abi/World.json";
import { Component, World } from "@latticexyz/solecs/types/ethers-contracts";
import { SyncState } from "./constants";
import { ECSStreamBlockBundleReply } from "@latticexyz/services/protobuf/ts/ecs-stream/ecs-stream";

/**
 * Create a ECSStateSnapshotServiceClient
 * @param url ECSStateSnapshotService URL
 * @returns ECSStateSnapshotServiceClient
 */
export function createSnapshotClient(url: string): ECSStateSnapshotServiceClient {
  const transport = new GrpcWebFetchTransport({ baseUrl: url, format: "binary" });
  return new ECSStateSnapshotServiceClient(transport);
}

/**
 * Create a ECSStreamServiceClient
 * @param url ECSStreamService URL
 * @returns ECSStreamServiceClient
 */
export function createStreamClient(url: string): ECSStreamServiceClient {
  const transport = new GrpcWebFetchTransport({ baseUrl: url, format: "binary" });
  return new ECSStreamServiceClient(transport);
}

/**
 * Return the snapshot block number.
 *
 * @param snapshotClient ECSStateSnapshotServiceClient
 * @param worldAddress Address of the World contract to get the snapshot for.
 * @returns Snapsot block number
 */
export async function getSnapshotBlockNumber(
  snapshotClient: ECSStateSnapshotServiceClient | undefined,
  worldAddress: string
): Promise<number> {
  let blockNumber = -1;
  if (!snapshotClient) return blockNumber;
  try {
    const { response } = await snapshotClient.getStateBlockLatest({ worldAddress });
    blockNumber = response.blockNumber;
  } catch (e) {
    console.error(e);
  }
  return blockNumber;
}

/**
 * Load from the remote snapshot service.
 *
 * @param snapshotClient ECSStateSnapshotServiceClient
 * @param worldAddress Address of the World contract to get the snapshot for.
 * @param decode Function to decode raw component values ({@link createDecode}).
 * @returns Promise resolving with {@link CacheStore} containing the snapshot state.
 */
export async function fetchSnapshot(
  snapshotClient: ECSStateSnapshotServiceClient,
  worldAddress: string,
  decode: ReturnType<typeof createDecode>
): Promise<CacheStore> {
  const cacheStore = createCacheStore();

  try {
    const { response } = await snapshotClient.getStateLatest({ worldAddress });
    await reduceFetchedState(response, cacheStore, decode);
  } catch (e) {
    console.error(e);
  }

  return cacheStore;
}

/**
 * Load from the remote snapshot service in chunks via a stream.
 *
 * @param snapshotClient ECSStateSnapshotServiceClient
 * @param worldAddress Address of the World contract to get the snapshot for.
 * @param decode Function to decode raw component values ({@link createDecode}).
 * @returns Promise resolving with {@link CacheStore} containing the snapshot state.
 */
export async function fetchSnapshotChunked(
  snapshotClient: ECSStateSnapshotServiceClient,
  worldAddress: string,
  decode: ReturnType<typeof createDecode>
): Promise<CacheStore> {
  const cacheStore = createCacheStore();

  try {
    const stream = snapshotClient.getStateLatestStream({ worldAddress });
    for await (const responseChunk of stream.responses) {
      await reduceFetchedState(responseChunk, cacheStore, decode);
    }
  } catch (e) {
    console.error(e);
  }

  return cacheStore;
}

/**
 * Reduces a snapshot response by storing corresponding ECS events into the cache store.
 *
 * @param response ECSStateReply
 * @param cacheStore {@link CacheStore} to store snapshot state into.
 * @param decode Function to decode raw component values ({@link createDecode}).
 * @returns Promise resolving once state is reduced into {@link CacheStore}.
 */
export async function reduceFetchedState(
  response: ECSStateReply,
  cacheStore: CacheStore,
  decode: ReturnType<typeof createDecode>
): Promise<void> {
  const { state, blockNumber, stateComponents, stateEntities } = response;

  for (const { componentIdIdx, entityIdIdx, value: rawValue } of state) {
    const component = to256BitString(stateComponents[componentIdIdx]);
    const entity = stateEntities[entityIdIdx] as EntityID;
    const value = await decode(component, rawValue);
    storeEvent(cacheStore, { component, entity, value, blockNumber });
  }
}

/**
 * Create a RxJS stream of {@link NetworkComponentUpdate}s by subscribing to a
 * gRPC streaming service.
 *
 * @param streamServiceUrl URL of the gPRC stream service to subscribe to.
 * @param worldAddress Contract address of the World contract to subscribe to.
 * @param transformWorldEvents Function to transform World events from a stream service ({@link createTransformWorldEventsFromStream}).
 * @returns Stream of {@link NetworkComponentUpdate}s.
 */
export function createLatestEventStreamService(
  streamServiceUrl: string,
  worldAddress: string,
  transformWorldEvents: ReturnType<typeof createTransformWorldEventsFromStream>
) {
  const streamServiceClient = createStreamClient(streamServiceUrl);
  const stream = streamServiceClient.subscribeToStreamLatest({
    worldAddress,
    blockNumber: true,
    blockHash: true,
    blockTimestamp: true,
    transactionsConfirmed: false, // do not need txs since each ECSEvent contains the hash
    ecsEvents: true,
  });

  // Turn stream responses into rxjs NetworkComponentUpdate
  return from(stream.responses).pipe(
    map(async (responseChunk) => {
      const events = await transformWorldEvents(responseChunk);
      console.log(`[SyncWorker] got ${events.length} events from block ${responseChunk.blockNumber}`);
      return events;
    }),
    awaitPromise(),
    concatMap((v) => of(...v))
  );
}

/**
 * Create a RxJS stream of {@link NetworkComponentUpdate}s by listening to new
 * blocks from the blockNumber$ stream and fetching the corresponding block
 * from the connected RPC.
 *
 * @dev Only use if {@link createLatestEventStreamRPC} is not available.
 *
 * @param blockNumber$ Block number stream
 * @param fetchWorldEvents Function to fetch World events in a block range ({@link createFetchWorldEventsInBlockRange}).
 * @returns Stream of {@link NetworkComponentUpdate}s.
 */
export function createLatestEventStreamRPC(
  blockNumber$: Observable<number>,
  fetchWorldEvents: ReturnType<typeof createFetchWorldEventsInBlockRange>
): Observable<NetworkComponentUpdate> {
  let lastSyncedBlockNumber: number | undefined;

  return blockNumber$.pipe(
    map(async (blockNumber) => {
      const from =
        lastSyncedBlockNumber == null || lastSyncedBlockNumber >= blockNumber ? blockNumber : lastSyncedBlockNumber + 1;
      const to = blockNumber;
      lastSyncedBlockNumber = to;
      const events = await fetchWorldEvents(from, to);
      console.log(`[SyncWorker] fetched ${events.length} events from block range ${from} -> ${to}`);
      return events;
    }),
    awaitPromise(),
    concatMap((v) => of(...v))
  );
}

/**
 * Fetch ECS state from contracts in the given block range.
 *
 * @param fetchWorldEvents Function to fetch World events in a block range ({@link createFetchWorldEventsInBlockRange}).
 * @param fromBlockNumber Start of block range (inclusive).
 * @param toBlockNumber End of block range (inclusive).
 * @param interval Chunk fetching the blocks in intervals to avoid overwhelming the client.
 * @returns Promise resolving with {@link CacheStore} containing the contract ECS state in the given block range.
 */
export async function fetchStateInBlockRange(
  fetchWorldEvents: ReturnType<typeof createFetchWorldEventsInBlockRange>,
  fromBlockNumber: number,
  toBlockNumber: number,
  interval = 50,
  setLoadingState?: (state: SyncState, msg: string, percentage: number) => void
): Promise<CacheStore> {
  const cacheStore = createCacheStore();
  const delta = toBlockNumber - fromBlockNumber;
  const numSteps = Math.ceil(delta / interval);
  const steps = [...range(numSteps, interval, fromBlockNumber)];

  for (let i = 0; i < steps.length; i++) {
    const from = steps[i];
    const to = i === steps.length - 1 ? toBlockNumber : steps[i + 1] - 1;
    const events = await fetchWorldEvents(from, to);

    if (setLoadingState) {
      setLoadingState(
        SyncState.INITIAL,
        `Fetching state from block ${fromBlockNumber} to ${toBlockNumber} (${i * interval}/${delta})`,
        80
      );
    }

    console.log(`[SyncWorker] initial sync fetched ${events.length} events from block range ${from} -> ${to}`);

    for (const event of events) {
      storeEvent(cacheStore, event);
    }
  }

  return cacheStore;
}

// Creates a function to decode raw component values
/**
 * Create a function to decode raw component values.
 * Fetches component schemas from the contracts and caches them.
 *
 * @param worldConfig Contract address and interface of the World contract
 * @param provider ethers JsonRpcProvider
 * @returns Function to decode raw component values using their contract component id
 */
export function createDecode(worldConfig: ContractConfig, provider: JsonRpcProvider) {
  const decoders: { [key: string]: (data: BytesLike) => ComponentValue } = {};
  const world = new Contract(worldConfig.address, worldConfig.abi, provider) as World;

  async function decode(componentId: string, data: BytesLike, componentAddress?: string): Promise<ComponentValue> {
    // Create the decoder if it doesn't exist yet
    if (!decoders[componentId]) {
      const address = componentAddress || (await world.getComponent(componentId));
      console.log("Creating decoder for", address);
      const component = new Contract(address, ComponentAbi, provider) as Component;
      const [keys, values] = await component.getSchema();
      decoders[componentId] = createDecoder(keys, values);
    }

    // Decode the raw value
    return decoders[componentId](data);
  }

  return decode;
}

/**
 * Create World contract topics for the `ComponentValueSet` and `ComponentValueRemoved` events.
 * @returns World contract topics for the `ComponentValueSet` and `ComponentValueRemoved` events.
 */
export function createWorldTopics() {
  return createTopics<{ World: World }>({
    World: { abi: WorldAbi, topics: ["ComponentValueSet", "ComponentValueRemoved"] },
  });
}

/**
 * Create a function to fetch World contract events in a given block range.
 * @param provider ethers JsonRpcProvider
 * @param worldConfig Contract address and interface of the World contract.
 * @param batch Set to true if the provider supports batch queries (recommended).
 * @param decode Function to decode raw component values ({@link createDecode})
 * @returns Function to fetch World contract events in a given block range.
 */
export function createFetchWorldEventsInBlockRange(
  provider: JsonRpcProvider,
  worldConfig: ContractConfig,
  batch: boolean | undefined,
  decode: ReturnType<typeof createDecode>
) {
  const topics = createWorldTopics();

  // Fetches World events in the provided block range (including from and to)
  return async (from: number, to: number) => {
    const contractsEvents = await fetchEventsInBlockRange(provider, topics, from, to, { World: worldConfig }, batch);
    const ecsEvents: NetworkComponentUpdate[] = [];

    for (const event of contractsEvents) {
      const { lastEventInTx, txHash, args } = event;
      const {
        component: address,
        entity: entityId,
        data,
        componentId: rawComponentId,
      } = args as unknown as {
        component: string;
        entity: BigNumber;
        data: string;
        componentId: BigNumber;
      };

      const component = to256BitString(BigNumber.from(rawComponentId).toHexString());
      const entity = BigNumber.from(entityId).toHexString() as EntityID;
      const blockNumber = to;

      const ecsEvent = {
        component,
        entity,
        value: undefined,
        blockNumber,
        lastEventInTx,
        txHash,
      };

      if (event.eventKey === "ComponentValueRemoved") {
        ecsEvents.push(ecsEvent);
      }

      if (event.eventKey === "ComponentValueSet") {
        const value = await decode(component, data, address);
        ecsEvents.push({ ...ecsEvent, value });
      }
    }

    return ecsEvents;
  };
}

/**
 * Create a function to transform World contract events from a stream service response chunk.
 * @param decode Function to decode raw component values ({@link createDecode})
 * @returns Function to transform World contract events from a stream service.
 */
export function createTransformWorldEventsFromStream(decode: ReturnType<typeof createDecode>) {
  return async (message: ECSStreamBlockBundleReply) => {
    const { blockNumber, ecsEvents } = message;

    const convertedEcsEvents: NetworkComponentUpdate[] = [];

    for (let i = 0; i < ecsEvents.length; i++) {
      const ecsEvent = ecsEvents[i];

      const rawComponentId = ecsEvent.componentId;
      const entityId = ecsEvent.entityId;
      const txHash = ecsEvent.tx;

      const component = to256BitString(BigNumber.from(rawComponentId).toHexString());
      const entity = to256BitString(BigNumber.from(entityId).toHexString()) as EntityID;

      const value = ecsEvent.value ? await decode(component, ecsEvent.value) : undefined;

      // Since ECS events are coming in ordered over the wire, we check if the following event has a
      // different transaction then the current, which would mean an event associated with another
      // tx
      const lastEventInTx = ecsEvents[i + 1]?.tx !== ecsEvent.tx;

      convertedEcsEvents.push({
        component,
        entity,
        value,
        blockNumber,
        lastEventInTx,
        txHash,
      });
    }

    return convertedEcsEvents;
  };
}