export {
  parseEnvelope,
  sealJson,
  unsealJson,
  type SealedEnvelope,
} from "./envelope";
export {
  createSeal,
  isRecoveryKeyFormat,
  parseKeybag,
  rewrapPassphrase,
  unlockWithPassphrase,
  unlockWithRecoveryKey,
  type CreateSealResult,
  type SealKeybag,
} from "./keybag";
export {
  clearSealSession,
  getSealDek,
  isSealUnlocked,
  lockSeal,
  setSealDek,
  subscribeSealSession,
} from "./session";
export {
  fetchSealState,
  fetchSealedSnapshot,
  putSealKeybag,
  putSealedSnapshot,
  SealSnapshotConflictError,
  type SealStateResponse,
} from "./api";
export {
  applySealRevisionDeltaToMap,
  buildSealRevisionDelta,
  nodesEqualForSeal,
  sealRevisionDeltaIsEmpty,
  type SealRevisionDelta,
} from "./revision-delta";
export {
  bindSealCollectionBridge,
  flushPersistSealedNodes,
  loadSealedNodes,
  persistSealedNodes,
  queuePersistSealedNodes,
  requestSealRevisionPull,
  schedulePersistSealedNodes,
  SEAL_FIELD_DEBOUNCE_MS,
  SEAL_IDLE_REVISION_MS,
  SEAL_REVISION_POLL_MS,
  type SealCollectionBridge,
} from "./sync";
export {
  forgetSealOnDevice,
  rememberSealOnDevice,
  tryUnlockFromDevice,
} from "./device";
