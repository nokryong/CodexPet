const { contextBridge, ipcRenderer } = require("electron");

// 말풍선 창 전용 IPC 채널입니다. main.js의 BUBBLE_CHANNELS와 같은 문자열을 사용해야 합니다.
const BUBBLE_CHANNELS = Object.freeze({
  UPDATE: "bubble:update",
  RESIZE: "bubble:resize",
  DISMISS: "bubble:dismiss",
  ACTION: "bubble:action",
});

contextBridge.exposeInMainWorld("bubbleApi", {
  // main이 보낸 말풍선 내용을 받아 렌더링합니다.
  onUpdate: (handler) => {
    const listener = (_event, data) => handler(data);
    ipcRenderer.on(BUBBLE_CHANNELS.UPDATE, listener);
    return () => ipcRenderer.removeListener(BUBBLE_CHANNELS.UPDATE, listener);
  },
  // 렌더링 후 실제 내용 높이를 main에 알려 창 크기를 맞춥니다.
  reportHeight: (height) => {
    ipcRenderer.send(BUBBLE_CHANNELS.RESIZE, height);
  },
  // 말풍선을 클릭하면 닫습니다.
  dismiss: () => {
    ipcRenderer.send(BUBBLE_CHANNELS.DISMISS);
  },
  // 말풍선 안의 버튼을 누르면 main process가 실제 동작을 처리합니다.
  // renderer에는 토큰 파일 경로나 인증 정보를 절대 넘기지 않습니다.
  sendAction: (actionId) => {
    ipcRenderer.send(BUBBLE_CHANNELS.ACTION, actionId);
  },
});
