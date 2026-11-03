// Ajuste de Opus en el SDP: tiene que seguir funcionando con SDP de clientes 2.x y no tocar nada mas.
// node --test "src/renderer/js/voice/test/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';
import { tuneOpusSdp, readOpusParams, OPUS_PTIME } from '../sdp.js';

// Lo que genera Chromium hoy (recortado): es lo que manda un cliente 2.x, sin parametros nuevos
const CHROMIUM_OFFER = [
  'v=0',
  'o=- 123 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0 1',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111 63 9 0 8',
  'c=IN IP4 0.0.0.0',
  'a=mid:0',
  'a=sendrecv',
  'a=rtpmap:111 opus/48000/2',
  'a=rtcp-fb:111 transport-cc',
  'a=fmtp:111 minptime=10;useinbandfec=1',
  'a=rtpmap:63 red/48000/2',
  'a=fmtp:63 111/111',
  'a=rtpmap:9 G722/8000',
  'a=rtpmap:0 PCMU/8000',
  'a=rtpmap:8 PCMA/8000',
  'm=video 9 UDP/TLS/RTP/SAVPF 96',
  'c=IN IP4 0.0.0.0',
  'a=mid:1',
  'a=rtpmap:96 VP8/90000',
  'a=fmtp:96 x-google-start-bitrate=1000',
  '',
].join('\r\n');

test('agrega FEC, DTX, mono, bitrate y ptime a Opus', () => {
  const out = tuneOpusSdp(CHROMIUM_OFFER, { maxAverageBitrate: 80000 });
  const opus = readOpusParams(out);
  assert.equal(opus.pt, '111');
  assert.equal(opus.params.useinbandfec, '1');
  assert.equal(opus.params.usedtx, '1');
  assert.equal(opus.params.stereo, '0');
  assert.equal(opus.params['sprop-stereo'], '0');
  assert.equal(opus.params.maxaveragebitrate, '80000');
  assert.equal(opus.params.minptime, '10', 'lo que ya estaba se conserva');
  assert.equal(opus.ptime, OPUS_PTIME);
});

test('no toca nada mas que Opus', () => {
  const out = tuneOpusSdp(CHROMIUM_OFFER, { maxAverageBitrate: 80000 });
  const original = CHROMIUM_OFFER.split('\r\n');
  const tuned = out.split('\r\n');
  const changed = original.filter((l) => !tuned.includes(l));
  assert.deepEqual(changed, ['a=fmtp:111 minptime=10;useinbandfec=1']);
  const added = tuned.filter((l) => !original.includes(l));
  assert.equal(added.length, 2, 'la linea de Opus y a=ptime');
  assert.ok(tuned.includes('a=fmtp:63 111/111'), 'RED queda igual');
  assert.ok(tuned.includes('a=fmtp:96 x-google-start-bitrate=1000'), 'el video queda igual');
  // a=ptime va dentro de la seccion de audio, no en la de video
  assert.ok(tuned.indexOf(`a=ptime:${OPUS_PTIME}`) < tuned.findIndex((l) => l.startsWith('m=video')));
});

test('aplicarlo dos veces da lo mismo y respeta el fin de linea', () => {
  const once = tuneOpusSdp(CHROMIUM_OFFER, { maxAverageBitrate: 40000 });
  assert.equal(tuneOpusSdp(once, { maxAverageBitrate: 40000 }), once);
  assert.ok(once.endsWith('\r\n'));
  const lf = tuneOpusSdp(CHROMIUM_OFFER.replaceAll('\r\n', '\n'), {});
  assert.ok(!lf.includes('\r'));
  assert.equal(readOpusParams(lf).params.usedtx, '1');
});

test('Opus sin linea fmtp: la crea al lado del rtpmap', () => {
  const sdp = ['v=0', 'm=audio 9 RTP/SAVPF 111', 'a=rtpmap:111 opus/48000/2', 'a=sendrecv', ''].join('\r\n');
  const lines = tuneOpusSdp(sdp, { maxAverageBitrate: 64000 }).split('\r\n');
  const at = lines.indexOf('a=rtpmap:111 opus/48000/2');
  assert.match(lines[at + 1], /^a=fmtp:111 useinbandfec=1;usedtx=1;stereo=0;sprop-stereo=0;maxaveragebitrate=64000$/);
});

test('conserva parametros desconocidos y reemplaza un ptime anterior', () => {
  const sdp = ['v=0', 'm=audio 9 RTP/SAVPF 111', 'a=rtpmap:111 OPUS/48000/2', 'a=fmtp:111 foo=bar;flag;stereo=1', 'a=ptime:60', ''].join('\n');
  const opus = readOpusParams(tuneOpusSdp(sdp, {}));
  assert.equal(opus.params.foo, 'bar');
  assert.equal(opus.params.flag, '');
  assert.equal(opus.params.stereo, '0');
  assert.equal(opus.ptime, OPUS_PTIME);
});

test('sin Opus (o sin SDP) devuelve lo mismo', () => {
  const noOpus = ['v=0', 'm=audio 9 RTP/SAVPF 0', 'a=rtpmap:0 PCMU/8000', ''].join('\r\n');
  assert.equal(tuneOpusSdp(noOpus, {}), noOpus);
  const onlyVideo = ['v=0', 'm=video 9 RTP/SAVPF 96', 'a=rtpmap:96 VP8/90000', ''].join('\r\n');
  assert.equal(tuneOpusSdp(onlyVideo, {}), onlyVideo);
  assert.equal(tuneOpusSdp('', {}), '');
  assert.equal(tuneOpusSdp(undefined, {}), undefined);
  assert.equal(readOpusParams(noOpus), null);
  assert.equal(readOpusParams(null), null);
});

test('el bitrate queda dentro de lo que permite Opus', () => {
  assert.equal(readOpusParams(tuneOpusSdp(CHROMIUM_OFFER, { maxAverageBitrate: 1000 })).params.maxaveragebitrate, '6000');
  assert.equal(readOpusParams(tuneOpusSdp(CHROMIUM_OFFER, { maxAverageBitrate: 9e9 })).params.maxaveragebitrate, '510000');
  assert.equal(readOpusParams(tuneOpusSdp(CHROMIUM_OFFER, { maxAverageBitrate: Infinity })).params.maxaveragebitrate, undefined);
  assert.equal(readOpusParams(tuneOpusSdp(CHROMIUM_OFFER, {})).params.maxaveragebitrate, undefined);
});

test('un SDP 2.x se lee sin parametros nuevos', () => {
  const opus = readOpusParams(CHROMIUM_OFFER);
  assert.equal(opus.params.usedtx, undefined);
  assert.equal(opus.params.maxaveragebitrate, undefined);
  assert.equal(opus.ptime, null);
});
