/** Copia al portapapeles; false si el navegador no dejo (el que llama explica como hacerlo a mano) */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // sin permiso de portapapeles: el metodo viejo todavia funciona en Chrome y Edge
    // select() le da el foco al textarea; al quitarlo el foco vuelve a donde estaba (si no, cae al body y
    // el siguiente Tab sale del modal)
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    if (previous?.isConnected) previous.focus({ preventScroll: true });
    return ok;
  }
}
