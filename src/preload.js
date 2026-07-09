const { contextBridge, ipcRenderer } = require("electron");

// main.js와 같은 IPC 채널명을 사용합니다.
// 보안상 renderer에서 ipcRenderer를 직접 노출하지 않고, 필요한 함수만 petApi로 감쌉니다.
const IPC_CHANNELS = Object.freeze({
  GET_APP_CONFIG: "pet:get-app-config",
  SET_STATE: "pet:set-state",
  REQUEST_REACTION: "pet:request-reaction",
  SHOW_CONTEXT_MENU: "pet:show-context-menu",
  DRAG_START: "pet:drag-start",
  DRAG_MOVE: "pet:drag-move",
  DRAG_END: "pet:drag-end",
  RESIZE_WINDOW: "pet:resize-window",
  SHOW_CODEX_STATUS: "pet:show-codex-status",
  SET_SPRITE: "pet:set-sprite",
});

// screenX/screenY만 main으로 보내면 main process가 창 위치를 안전하게 계산합니다.
// DOM PointerEvent 전체를 contextBridge 너머로 넘기면 속성이 비어 NaN 좌표가 생길 수 있으므로 plain object만 받습니다.
function normalizeScreenPoint(point) {
  const screenX = Number(point?.screenX);
  const screenY = Number(point?.screenY);

  if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) {
    console.warn("[desktop-pet] Invalid drag point ignored.", point);
    return null;
  }

  return {
    screenX,
    screenY,
  };
}

// renderer.js에서 사용할 최소 API입니다.
// 나중에 Codex 상태 연동을 추가할 때도 이 객체에 requestCodexState 같은 함수를 추가하면 됩니다.
contextBridge.exposeInMainWorld("petApi", {
  getAppConfig: () => ipcRenderer.invoke(IPC_CHANNELS.GET_APP_CONFIG),
  onStateChange: (handler) => {
    const listener = (_event, stateName) => handler(stateName);
    ipcRenderer.on(IPC_CHANNELS.SET_STATE, listener);

    // renderer가 재로딩될 때 리스너를 정리할 수 있도록 unsubscribe 함수를 돌려줍니다.
    return () => ipcRenderer.removeListener(IPC_CHANNELS.SET_STATE, listener);
  },
  // 메뉴에서 펫을 바꾸면 main이 새 스프라이트 URL을 보내줍니다.
  onSpriteChange: (handler) => {
    const listener = (_event, spriteUrl) => handler(spriteUrl);
    ipcRenderer.on(IPC_CHANNELS.SET_SPRITE, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.SET_SPRITE, listener);
  },
  requestReaction: (stateName) => {
    ipcRenderer.send(IPC_CHANNELS.REQUEST_REACTION, stateName);
  },
  showContextMenu: () => {
    ipcRenderer.send(IPC_CHANNELS.SHOW_CONTEXT_MENU);
  },
  dragStart: (point) => {
    const screenPoint = normalizeScreenPoint(point);
    if (screenPoint) {
      ipcRenderer.send(IPC_CHANNELS.DRAG_START, screenPoint);
    }
  },
  dragMove: (point) => {
    const screenPoint = normalizeScreenPoint(point);
    if (screenPoint) {
      ipcRenderer.send(IPC_CHANNELS.DRAG_MOVE, screenPoint);
    }
  },
  dragEnd: () => {
    ipcRenderer.send(IPC_CHANNELS.DRAG_END);
  },
  resizeWindow: (width, height) => {
    ipcRenderer.send(IPC_CHANNELS.RESIZE_WINDOW, width, height);
  },
  showCodexStatus: () => {
    ipcRenderer.send(IPC_CHANNELS.SHOW_CODEX_STATUS);
  }
});
