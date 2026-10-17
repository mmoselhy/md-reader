// SCAFFOLD STUB: Task B replaces this file. Shows the window so the skeleton is runnable.
const { invoke } = window.__TAURI__.core;

const doc = await invoke('initial_doc').catch((e) => ({ html: `<p>${e}</p>` }));
document.getElementById('content').innerHTML = doc ? doc.html : '<p>mdread skeleton</p>';
invoke('mark_ready');
