import { spawn } from 'node:child_process';

/** aviso del sistema operativo: sale aunque no haya ninguna pestana abierta */
export interface Notifier {
  notify(title: string, body: string): void;
}

export const NO_NOTIFIER: Notifier = { notify: () => {} };

/** nada de lo que viene de un transcript llega aqui: titulo y cuerpo los arma el servidor con cifras y nombres */
function clean(text: string, max: number): string {
  return text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
}

function run(cmd: string, args: readonly string[], env?: NodeJS.ProcessEnv): void {
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', windowsHide: true, detached: false, env: env ?? process.env });
    // sin el comando (p.ej. notify-send no instalado) el aviso se pierde en silencio
    child.on('error', () => {});
    child.unref();
  } catch {
    // no se pudo lanzar: sin aviso
  }
}

// el texto viaja por variables de entorno, nunca dentro del script
const WINDOWS_TOAST = [
  '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
  '$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
  "$text = $xml.GetElementsByTagName('text')",
  '$text.Item(0).AppendChild($xml.CreateTextNode($env:COLMENA_TITLE)) > $null',
  '$text.Item(1).AppendChild($xml.CreateTextNode($env:COLMENA_BODY)) > $null',
  '$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)',
  // AppId de PowerShell: uno propio sin registrar no muestra el aviso
  "$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
  '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show($toast)',
].join('; ');

/** avisos nativos sin dependencias: toast de Windows (PowerShell), notify-send en Linux, osascript en macOS */
export function systemNotifier(platform: NodeJS.Platform = process.platform): Notifier {
  return {
    notify(rawTitle, rawBody) {
      const title = clean(rawTitle, 120);
      const body = clean(rawBody, 300);
      if (!title) return;
      if (platform === 'win32') {
        run('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', WINDOWS_TOAST], {
          ...process.env,
          COLMENA_TITLE: title,
          COLMENA_BODY: body,
        });
      } else if (platform === 'darwin') {
        run('osascript', [
          '-e',
          'on run argv',
          '-e',
          'display notification (item 2 of argv) with title (item 1 of argv)',
          '-e',
          'end run',
          title,
          body,
        ]);
      } else {
        run('notify-send', ['--app-name=Colmena', '--', title, body]);
      }
    },
  };
}
