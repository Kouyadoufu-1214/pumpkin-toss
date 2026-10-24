export const PUBLIC_APP_URL = 'https://kouyadoufu-1214.github.io/pumpkin-toss/';

export function setupShareControls({ document = globalThis.document, navigator = globalThis.navigator } = {}) {
  const button = document.getElementById('share-button');
  const dialog = document.getElementById('share-dialog');
  const closeButton = document.getElementById('close-share');
  const input = document.getElementById('share-url');
  const copyButton = document.getElementById('copy-share');
  const status = document.getElementById('share-status');
  const openLink = document.getElementById('share-open');
  let revision = 0;
  let copying = false;

  input.value = PUBLIC_APP_URL;
  openLink.href = PUBLIC_APP_URL;

  function resetPendingCopy() {
    revision += 1;
    copying = false;
    copyButton.disabled = false;
  }

  function open() {
    resetPendingCopy();
    input.value = PUBLIC_APP_URL;
    status.textContent = '';
    if (!dialog.open) dialog.showModal();
  }

  function close() {
    resetPendingCopy();
    dialog.close();
  }

  function onClose() {
    // A queued close event can arrive after the dialog has opened again.
    if (!dialog.open) resetPendingCopy();
  }

  async function copy() {
    if (!dialog.open || copying) return;
    const currentRevision = revision;
    copying = true;
    copyButton.disabled = true;
    status.textContent = '';
    let copied = false;
    try {
      if (typeof navigator?.clipboard?.writeText === 'function') {
        await navigator.clipboard.writeText(PUBLIC_APP_URL);
        copied = true;
      }
    } catch {
      // Browser permissions can prohibit clipboard access; leave a selectable URL.
    } finally {
      if (currentRevision === revision && dialog.open) {
        copying = false;
        copyButton.disabled = false;
        if (copied) {
          status.textContent = '共有URLをコピーしました。メッセージに貼り付けて送れます。';
        } else {
          input.value = PUBLIC_APP_URL;
          input.focus();
          input.select();
          status.textContent = 'URLを選択しました。Ctrl+Cでコピーしてください。';
        }
      }
    }
  }

  button.addEventListener('click', open);
  closeButton.addEventListener('click', close);
  copyButton.addEventListener('click', copy);
  dialog.addEventListener('cancel', resetPendingCopy);
  dialog.addEventListener('close', onClose);

  return () => {
    resetPendingCopy();
    button.removeEventListener('click', open);
    closeButton.removeEventListener('click', close);
    copyButton.removeEventListener('click', copy);
    dialog.removeEventListener('cancel', resetPendingCopy);
    dialog.removeEventListener('close', onClose);
  };
}
