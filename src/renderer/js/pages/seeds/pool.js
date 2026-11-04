// Hilos de calculo del visor. Cada hilo hace un trabajo por vez y, al quedar libre, le pide el siguiente al mapa
// (`nextJob`): asi lo que ya no se ve simplemente deja de pedirse. Si el Worker no arranca, sigue en el hilo de la
// interfaz, de a un trabajo por vez, para no trabarla.

// Misma forma que un Worker, en el hilo de la interfaz
class InlineWorker {
  constructor() {
    this.onmessage = null;
    this.chain = import('./service.js').then((m) => {
      this.service = m.createService((msg) => setTimeout(() => this.onmessage?.({ data: msg }), 0));
    });
  }

  postMessage(msg) {
    this.chain = this.chain.then(() => new Promise((r) => setTimeout(r, 0))).then(() => (this.dead ? null : this.service.handle(msg)));
  }

  terminate() {
    this.dead = true;
  }
}

export class GenPool {
  constructor({ nextJob, onReply, size }) {
    this.nextJob = nextJob;
    this.onReply = onReply;
    this.gen = 0;
    this.seq = 0;
    this.current = null;
    this.dead = false;
    this.inline = false;
    const cores = navigator.hardwareConcurrency || 4;
    this.size = size || Math.max(1, Math.min(4, cores - 2));
    this.slots = [];
    for (let i = 0; i < this.size; i++) this.addWorker();
  }

  addWorker() {
    const slot = { busy: null, index: this.slots.length, worker: null };
    this.slots.push(slot);
    try {
      slot.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      slot.worker.onerror = (e) => this.onWorkerError(e);
    } catch (err) {
      console.warn('[seeds] sin Worker', err?.message || err);
      this.useInline();
      return;
    }
    slot.worker.onmessage = (e) => this.onMessage(slot, e.data);
  }

  onWorkerError(e) {
    console.warn('[seeds] el Worker fallo', e?.message || e);
    e?.preventDefault?.();
    this.useInline();
  }

  // Un solo hilo "falso": los trabajos que estaban en camino se vuelven a pedir
  useInline() {
    if (this.inline || this.dead) return;
    this.inline = true;
    for (const s of this.slots) s.worker?.terminate();
    const slot = { busy: null, index: 0, worker: new InlineWorker() };
    slot.worker.onmessage = (e) => this.onMessage(slot, e.data);
    this.slots = [slot];
    this.size = 1;
    this.onReply({ t: 'restart' });
    if (this.current) slot.worker.postMessage({ t: 'init', ...this.current, gen: this.gen });
    this.pump();
  }

  // Cambia de mundo: los hilos preparan el nuevo; lo que llegue del anterior se ignora
  setWorld(params) {
    this.gen++;
    this.current = params;
    for (const s of this.slots) s.worker?.postMessage({ t: 'init', ...params, gen: this.gen });
    this.pump();
  }

  onMessage(slot, msg) {
    if (msg.job && slot.busy === msg.job) slot.busy = null;
    if (msg.gen === this.gen && msg.t !== 'skip') this.onReply(msg);
    this.pump();
  }

  pump() {
    if (this.dead || !this.current) return;
    for (const s of this.slots) {
      if (s.busy || !s.worker) continue;
      const job = this.nextJob(s.index, this.size);
      if (!job) break;
      const id = ++this.seq;
      s.busy = id;
      const { transfer, ...msg } = job;
      s.worker.postMessage({ ...msg, gen: this.gen, job: id }, transfer || []);
    }
  }

  get working() {
    return this.slots.some((s) => s.busy);
  }

  destroy() {
    this.dead = true;
    for (const s of this.slots) s.worker?.terminate();
    this.slots = [];
  }
}
