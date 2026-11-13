// Abre Colmena sin ninguna ventana de terminal: corre launcher/colmena.mts --oculto con la consola oculta y
// espera a que termine (Colmena se apaga sola cuando no queda ninguna pestana abierta). Si algo sale mal,
// muestra el motivo en un mensaje. Lo usan el acceso directo del escritorio y Colmena.cmd.
// Es JScript de Windows Script Host (wscript.exe), no Node: sin sintaxis moderna y sin caracteres fuera de
// ASCII en el archivo (wscript lo lee en la pagina de codigos del sistema), por eso las tildes van con \u.
var shell = WScript.CreateObject('WScript.Shell');
var fso = WScript.CreateObject('Scripting.FileSystemObject');
var root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName));
var HIDDEN = 0;
var ICON_ERROR = 16;
var ICON_INFO = 64;
shell.CurrentDirectory = root;

function notify(text, icon, seconds) {
  return shell.Popup(text, seconds || 0, 'Colmena', icon);
}

function run(command) {
  return shell.Run('%ComSpec% /c ' + command, HIDDEN, true);
}

if (run('where node') !== 0) {
  notify(
    'Colmena necesita Node.js 24 LTS.\n\nInstálalo desde el portal de software de la empresa y vuelve a abrir Colmena.',
    ICON_ERROR
  );
  WScript.Quit(1);
}

if (!fso.FileExists(root + '\\node_modules\\.package-lock.json')) {
  notify(
    'Primera vez: instalando lo que Colmena necesita. Tarda unos minutos y se abre sola al terminar.',
    ICON_INFO,
    8
  );
  if (run('npm ci') !== 0) {
    notify('No se pudieron instalar las dependencias. Revisa la sección Instalación del README.', ICON_ERROR);
    WScript.Quit(1);
  }
}

var code = run('node --import tsx launcher\\colmena.mts --oculto');
if (code !== 0) {
  var errorFile = root + '\\server\\data\\lanzador-error.txt';
  var reason = 'Colmena se cerró de forma inesperada (código ' + code + ').';
  if (fso.FileExists(errorFile)) {
    var file = fso.OpenTextFile(errorFile, 1, false, -1);
    reason = file.ReadAll();
    file.Close();
  }
  notify(reason, ICON_ERROR);
  WScript.Quit(1);
}
