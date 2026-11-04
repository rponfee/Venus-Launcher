// Worker del Visor de semillas: los trabajos corren de a uno y en orden.
import { createService } from './service.js';

const service = createService((msg, transfer) => self.postMessage(msg, transfer || []));
let chain = Promise.resolve();
self.onmessage = (e) => {
  chain = chain.then(() => service.handle(e.data)).catch((err) => console.error('[seeds]', err));
};
