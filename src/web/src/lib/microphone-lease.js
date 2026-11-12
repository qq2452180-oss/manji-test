import { openMicrophone, startMicrophoneMeter, stopMicrophoneStream } from './realtime-web-rtc.js';

const unavailable = () => Object.assign(new Error('麦克风已关闭，请重新开启后重试。'), { code: 'MIC_UNAVAILABLE' });
const cancelled = () => Object.assign(new Error('麦克风准备已取消。'), { code: 'RTC_CLOSED' });
const hasLiveAudio = stream => stream?.getAudioTracks?.().some(track => track.readyState !== 'ended');

// The guide owns this capture until take() transfers it to the RTC adapter.
// Releasing the guide afterwards must not stop the transferred call's microphone.
export function createMicrophoneLease({ onLevel } = {}) {
  let ownedStream, pending, stopMeter;
  let generation = 0;
  const stopMeasuring = () => {
    stopMeter?.();
    stopMeter = null;
  };
  const close = () => {
    generation += 1;
    pending = null;
    stopMeasuring();
    stopMicrophoneStream(ownedStream);
    ownedStream = null;
  };
  return {
    prepare() {
      if (hasLiveAudio(ownedStream)) return Promise.resolve(ownedStream);
      if (pending) return pending;
      stopMeasuring();
      stopMicrophoneStream(ownedStream);
      ownedStream = null;
      const current = generation;
      const request = (async () => {
        let stream;
        try {
          stream = await openMicrophone();
          if (current !== generation) {
            stopMicrophoneStream(stream);
            throw cancelled();
          }
          ownedStream = stream;
          const meter = startMicrophoneMeter(stream, onLevel);
          if (current !== generation) { meter(); throw cancelled(); }
          stopMeter = meter;
          return stream;
        } finally {
          // A late result from a closed permission request cannot clear a newer
          // request, restart its meter, or replace its microphone stream.
          if (pending === request) pending = null;
        }
      })();
      pending = request;
      return request;
    },
    take() {
      if (!hasLiveAudio(ownedStream)) { close(); throw unavailable(); }
      const stream = ownedStream;
      ownedStream = null;
      generation += 1;
      pending = null;
      stopMeasuring();
      return stream;
    },
    close,
  };
}
