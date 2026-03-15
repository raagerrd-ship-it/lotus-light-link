// Background tick worker — continues running when tab is hidden
let intervalId = null;
let currentMs = 125;

self.onmessage = (e) => {
  if (e.data === 'start') {
    if (intervalId) clearInterval(intervalId);
    intervalId = setInterval(() => self.postMessage('tick'), currentMs);
  } else if (e.data === 'stop') {
    if (intervalId) clearInterval(intervalId);
    intervalId = null;
  } else if (typeof e.data === 'number') {
    currentMs = e.data;
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = setInterval(() => self.postMessage('tick'), currentMs);
    }
  }
};
