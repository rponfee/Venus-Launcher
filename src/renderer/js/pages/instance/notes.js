// Notas y tareas de la instancia: un cuadro de texto que se guarda solo (500 ms despues de dejar de escribir)
// y una lista de tareas con casillas, agregar y borrar. Se guardan en venus-instance.json (notes) por
// instances.update; el proceso principal recorta a 20000 caracteres, 100 tareas de 200 caracteres.
import { h, icon, mount, fail, emptyState, debounce, confirmDialog } from '../../ui.js';
import { store, api } from '../../store.js';
import { t } from '../../i18n.js';
import { iconButton } from '../versions/common.js';

const TEXT_MAX = 20000;
const TASK_MAX = 100;
const TASK_LEN = 200;
const SAVE_DELAY = 500;

function newId() {
  return Math.random().toString(36).slice(2, 10).padEnd(8, '0');
}

function cloneNotes(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    text: typeof src.text === 'string' ? src.text : '',
    tasks: (Array.isArray(src.tasks) ? src.tasks : []).filter((x) => x && typeof x.text === 'string' && x.text).map((x) => ({ id: typeof x.id === 'string' && x.id ? x.id : newId(), text: x.text, done: x.done === true })),
  };
}

export function notesTab(container, ctx) {
  let alive = true;
  const notes = cloneNotes(ctx.inst.notes);
  const tasksBox = h('div', { class: 'ih-tasks' });
  const countBox = h('span', { class: 'small muted num', 'aria-live': 'polite' });
  const charsBox = h('span', { class: 'tiny muted num' });
  const clearBtn = h('button', { class: 'btn sm ghost', type: 'button' }, icon('trash'), t('instance.tasksClearDone'));
  const fullHint = h('div', { class: 'hint field-help hidden' }, t('instance.tasksFull'));

  // Estado del guardado automatico (sin mover el foco)
  const saveState = h('div', { class: 'ih-savestate', role: 'status' });
  let saveTimer = 0;
  const showSave = (kind) => {
    clearTimeout(saveTimer);
    saveState.className = `ih-savestate ${kind || ''}`;
    if (kind === 'saved') mount(saveState, icon('check'), t('instance.saved'));
    else if (kind === 'error') mount(saveState, icon('alert'), t('instance.saveFailed'));
    else if (kind === 'pending') mount(saveState, icon('clock'), t('instance.notesSaving'));
    else mount(saveState, icon('info'), t('instance.notesHint'));
    if (kind === 'saved') saveTimer = setTimeout(() => alive && showSave(null), 2500);
  };
  showSave(null);

  let dirty = false;
  const flush = async () => {
    if (!dirty) return;
    dirty = false;
    try {
      const next = await api.instances.update(ctx.id, { notes: { text: notes.text, tasks: notes.tasks } });
      if (!alive) return;
      ctx.setInstance(next);
      showSave(dirty ? 'pending' : 'saved');
      store.refreshInstances();
    } catch (err) {
      if (alive) showSave('error');
      fail(t('instance.saveFailed'), err);
    }
  };
  const flushLater = debounce(flush, SAVE_DELAY);
  const save = () => {
    dirty = true;
    showSave('pending');
    flushLater();
  };

  // Texto libre
  const textarea = h('textarea', { class: 'textarea ih-notes-text', maxlength: String(TEXT_MAX), placeholder: t('instance.notesPlaceholder'), 'aria-label': t('instance.notesTitle'), spellcheck: 'true' });
  textarea.value = notes.text;
  const drawChars = () => mount(charsBox, t('instance.notesChars', { count: notes.text.length, max: TEXT_MAX }));
  textarea.addEventListener('input', () => {
    notes.text = textarea.value.slice(0, TEXT_MAX);
    drawChars();
    save();
  });
  drawChars();

  // Tareas
  const input = h('input', { class: 'input', type: 'text', maxlength: String(TASK_LEN), placeholder: t('instance.taskPlaceholder'), 'aria-label': t('instance.taskPlaceholder'), autocomplete: 'off' });
  const addBtn = h('button', { class: 'btn sm tonal', type: 'button', onclick: () => addTask() }, icon('plus'), t('instance.taskAdd'));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addTask();
    }
  });

  function addTask() {
    const text = input.value.replace(/\s+/g, ' ').trim().slice(0, TASK_LEN);
    if (!text || notes.tasks.length >= TASK_MAX) return;
    notes.tasks.push({ id: newId(), text, done: false });
    input.value = '';
    drawTasks();
    save();
    input.focus();
  }

  function toggleTask(task, done) {
    task.done = done;
    drawTasks();
    save();
  }

  function removeTask(task) {
    notes.tasks = notes.tasks.filter((x) => x !== task);
    drawTasks();
    save();
  }

  clearBtn.addEventListener('click', async () => {
    const done = notes.tasks.filter((x) => x.done);
    if (!done.length) return;
    if (!(await confirmDialog(t('instance.tasksClearDone'), t('instance.tasksClearDoneText', { count: done.length }), { okText: t('instance.delete'), danger: true }))) return;
    notes.tasks = notes.tasks.filter((x) => !x.done);
    drawTasks();
    save();
  });

  function taskRow(task) {
    const id = `ih-task-${task.id}`;
    const check = h('input', { type: 'checkbox', class: 'ih-task-check', id, checked: task.done });
    check.addEventListener('change', () => toggleTask(task, check.checked));
    check.setAttribute('aria-label', task.done ? t('instance.taskUndone', { text: task.text }) : t('instance.taskDone', { text: task.text }));
    return h(
      'li',
      { class: ['ih-task', task.done && 'done'] },
      check,
      h('label', { for: id, class: 'ih-task-text' }, task.text),
      iconButton('trash', t('instance.taskDelete', { text: task.text }), () => removeTask(task), 'danger ih-task-del'),
    );
  }

  function drawTasks() {
    const pending = notes.tasks.filter((x) => !x.done).length;
    const done = notes.tasks.length - pending;
    mount(countBox, notes.tasks.length ? (pending ? t('instance.tasksPending', { count: pending }) : t('instance.tasksAllDone')) : '');
    clearBtn.hidden = !done;
    const full = notes.tasks.length >= TASK_MAX;
    input.disabled = full;
    addBtn.disabled = full;
    fullHint.classList.toggle('hidden', !full);
    if (!notes.tasks.length) {
      mount(tasksBox, emptyState('vsTasks', t('instance.tasksEmpty'), t('instance.tasksEmptyText')));
      return;
    }
    // Pendientes primero, hechas al final (cada grupo en el orden en que se agregaron)
    const ordered = [...notes.tasks.filter((x) => !x.done), ...notes.tasks.filter((x) => x.done)];
    mount(tasksBox, h('ul', { class: 'ih-task-list' }, ordered.map(taskRow)));
  }

  mount(
    container,
    h(
      'div',
      { class: 'stack ih-notes-wrap' },
      h('div', { class: 'ih-subbar' }, saveState),
      h(
        'div',
        { class: 'grid ih-notes-grid' },
        h(
          'section',
          { class: 'card ih-notes', 'aria-labelledby': 'ih-notes-title' },
          h('div', { class: 'card-head' }, h('div', {}, h('h2', { class: 'card-title', id: 'ih-notes-title' }, icon('fileText'), t('instance.notesTitle')), h('p', { class: 'card-sub' }, t('instance.notesSub'))), charsBox),
          textarea,
        ),
        h(
          'section',
          { class: 'card ih-tasks-card', 'aria-labelledby': 'ih-tasks-title' },
          h('div', { class: 'card-head' }, h('div', {}, h('h2', { class: 'card-title', id: 'ih-tasks-title' }, icon('vsTasks'), t('instance.tasksTitle')), h('p', { class: 'card-sub' }, t('instance.tasksSub'))), h('div', { class: 'row' }, countBox, clearBtn)),
          h('div', { class: 'row ih-task-add' }, input, addBtn),
          fullHint,
          tasksBox,
        ),
      ),
    ),
  );
  drawTasks();

  return () => {
    alive = false;
    // Lo que quedo sin guardar se guarda al salir de la pestania
    if (dirty) flush();
  };
}
