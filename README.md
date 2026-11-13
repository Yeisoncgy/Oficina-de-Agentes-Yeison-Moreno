![Colmena. Tus agentes trabajando, en vivo: local, solo lectura y cero tokens extra.](docs/colmena-hero.png)

# Colmena · Tus agentes trabajando

Una oficina 3D en miniatura, con luz y materiales de cine, para ver qué hacen tus sesiones de Claude Code:
una sala por sesión, un escritorio por agente, y sus tareas, tokens y costo equivalente en vivo.

> **Cero tokens extra.** Colmena solo lee lo que Claude Code ya guarda en `~/.claude`
> (`%USERPROFILE%\.claude`). No escribe ahí, no instala hooks y no llama a la API de Anthropic.

![](docs/pixel-divider.png)

## Requisitos

| Requisito | Detalle |
|:---|:---|
| Sistema | Windows |
| Node.js | **24 LTS, versión 24.15 o superior** |
| Navegador | Edge o Chrome con WebGL 2. Sin WebGL 2 no se dibuja la oficina 3D, pero los paneles funcionan. |
| Claude Code | Haberlo usado al menos una vez, para que exista `~/.claude`. |

## Instalar y abrir

```powershell
npm ci
npm start
```

Levanta el server (puerto 4317) y la web (puerto 5317). Abre http://127.0.0.1:5317 y apágala con Ctrl+C.
`npm start` compila la oficina y la sirve ya optimizada, que es como va más fluida. `npm run dev` la abre en
modo de desarrollo (recarga sola al tocar el código, pero es más lenta): úsalo solo para programarla.

También puedes abrirla con doble clic en **`Colmena.cmd`**: no muestra terminal, abre la oficina en el
navegador y se apaga sola 3 minutos después de cerrar la última pestaña. Usa la versión compilada: la
compila sola la primera vez y cada vez que cambia el código (unos segundos). Para un acceso directo, usa este
destino (cambiando la carpeta por la tuya) y el icono `launcher\colmena.ico`:

```
wscript.exe "C:\ruta\a\Colmena\launcher\Colmena.js"
```

`npm run colmena` abre una consola con el estado del servidor, la oficina y el historial.

### Primer arranque

- Pregunta tu nombre: es el del líder y sale en tu escritorio, el ranking y Hábitos.
- Muestra una guía corta (se repite con el botón **Guía** dentro de Hábitos).
- Lee tu historial de Claude Code y muestra el avance. La primera lectura es la más larga.

### Modo demo y otra carpeta de Claude

- http://127.0.0.1:5317/?demo=1: la oficina con datos de ejemplo, simulados en el navegador.
- Si Claude Code guarda sus datos en otra carpeta, indícala con `CLAUDE_HOME`:

  ```powershell
  $env:CLAUDE_HOME = "C:\ruta\a\tu\carpeta\.claude"
  npm run dev
  ```

## Controles

| Tecla | Qué hace |
|---|---|
| `L` | Abre o cierra "Agentes ahora": quién trabaja, en qué, desde cuándo y cuánto lleva |
| `P` | Abre o cierra tus **Pendientes**: una lista general de cosas por hacer |
| `A` | Abre o cierra Hábitos (gasto, eficiencia, reglas, precios y sistema) |
| `H` | Abre o cierra ese panel en la última pestaña vista |
| `F` | Lleva a la sala del flujo en curso y abre su panel |
| `Tab` | Despliega o pliega la lista de salas |
| Flechas | Con la lista desplegada, pasan a la sala anterior o siguiente |
| `Esc` | Cierra lo que está arriba |

Cámara: arrastra con el clic izquierdo para moverte y con el derecho (o Ctrl+clic) para girar; la rueda hace
zoom. Doble clic en una sala la enfoca y doble clic en el vacío muestra todo. Con el teclado: flechas, `Q`/`E`
para girar, `+`/`-` para zoom y `0` para ver todo.

## Hora, calidad y rendimiento

- **Hora de la oficina:** en la barra de arriba, a la izquierda, hay cuatro botones: automática (sigue la
  hora real), día, atardecer y noche. Lo que elijas se recuerda en ese navegador. Solo cambia la luz; el
  reloj de pared de las salas sigue marcando la hora real.
- **Calidad:** el botón del velocímetro, junto a la hora, rota entre automática, alta, media y baja. En
  automática arranca según la tarjeta gráfica (dedicada: alta; integrada: media; sin aceleración: baja) y, si
  el equipo no alcanza, baja sola un nivel. Alta lleva sombreado de contacto; media es la pensada para
  gráficos integrados; baja dibuja a menor resolución. También se fija con `?calidad=alta|media|baja` en la
  dirección. `?fx=0` apaga todo el revelado.
- **Consumo:** la escena va a 60 cuadros por segundo mientras la usas (puntero encima, arrastre, rueda,
  cámara en movimiento), a 30 cuando está quieta y a 20 si la ventana está a la vista pero trabajas en otra.
  Con la pestaña oculta no dibuja. Las sombras solo se recalculan cuando alguien camina. La interfaz no usa
  desenfoques de fondo, que es lo que más pesa en equipos sin tarjeta dedicada.
- **Medir un equipo:** agrega `?perf=1` a la dirección y aparece abajo a la izquierda una lectura en vivo:
  cuadros por segundo reales y buscados, milisegundos que tarda la tarjeta en un cuadro, y el nivel de calidad.
- **Vista ligera:** `?lite=1` muestra los mismos datos sin la oficina 3D.

## Privacidad

- La base local `server/data/office.db` es solo tuya (historial leído, notas, nombres de salas, presupuesto,
  reglas y tu nombre). No la subas: el `.gitignore` ya la deja fuera.
- No borres la base para actualizar: las notas, nombres, presupuesto y reglas no se recuperan.
- El panel de un agente muestra prompts y respuestas completos. Ciérralo antes de proyectar la pantalla.
- Colmena solo escucha en `127.0.0.1`.

## Costos

- Los USD son el **valor equivalente de la API**, no un cobro del plan.
- El presupuesto mensual por defecto es 500 USD; se cambia en Hábitos > Gasto > Presupuesto.
- "Ocultar gasto" lo esconde hasta que lo vuelvas a mostrar.

### Control del presupuesto

- **Avisos del mes.** Al cruzar el 50, 75, 90 y 100 % sale una franja en la app y un aviso del sistema. También
  avisa cuando la proyección pasa el tope, cuando hoy ya se gastó más de lo recomendado por día y cuando un
  proyecto pasa su tope.
- **Ritmo en vivo.** La barra superior muestra el gasto de la última hora y el día en que se acaba el presupuesto
  al ritmo actual (o el día en que ya se pasó).
- **Topes atados al saldo.** Las reglas de costo no se calibran solo con tu historial: una sesión no debería pasar
  en un día del recomendado por día, un flujo del 25 % de lo que queda del mes y un agente del 10 %.
- **Topes por proyecto y semana.** En Presupuesto se le pone un tope mensual a cada proyecto y se ve lo que le toca
  a la semana en curso.
- **Flujos contra el saldo.** Un flujo en curso muestra qué parte de lo que queda del mes se llevaría; al terminar,
  su cierre: costo por fase y por rol, lo descartado y el primer pronóstico contra el costo real.
- **Cierre de mes.** Presupuesto lista cada mes con datos: gastado, parte en flujos, descartado y lo más caro.

### Precios

- Ningún modelo de una familia conocida queda en cero. Si un modelo no está en la tabla se cotiza con un precio
  **estimado**: el que reproduce lo que Claude Code calculó en su propio registro, o el del modelo más nuevo de su
  familia. Lo estimado se marca y se suma aparte en Presupuesto y Costos.
- En Hábitos > Reglas > Precios se fija el precio correcto de cualquier modelo. Cada cambio recotiza todo el
  historial desde la base local, sin releer nada.
- El gasto que Claude Code hace por debajo (búsquedas y resúmenes) y que no aparece en las conversaciones se suma
  desde su registro. Costos trae la conciliación: lo que dice Claude Code contra lo que leyó Colmena.

## Quién hace qué

- **Agentes ahora** (`L`) tiene vista de **Árbol**: quién lanzó a quién y cuánto lleva cada rama. Muestra el
  tamaño del contexto de cada agente, su ritmo por minuto y cuánto lleva sin actividad o esperando tu respuesta.
- **Panel del agente:** su contexto actual, lo que cuesta su próxima llamada solo por releerlo y la línea de tiempo
  de sus acciones (hora, duración, fallos y bloqueos).
- **Panel de la sala:** cada turno del líder con su costo y los archivos que tocó cada agente, con aviso cuando dos
  editaron el mismo.
- **Tareas** tiene buscador y filtros (proyecto, quién, cómo terminó, costo mínimo, periodo) y dice cómo terminó
  cada una. **Sesiones** lista todas las sesiones con gasto, no solo las que caben en la oficina.

## Pendientes

Una lista de cosas por hacer para toda la herramienta (`P`, o el botón "Pendientes" arriba a la izquierda). Escribes,
Enter, y al terminar marcas la casilla. No pertenece a ninguna sala ni sesión: es la misma en todas las pestañas y
se guarda en la base local. Las notas de cada sala siguen aparte, en su sala.

## Eficiencia

- **Costos** reparte el gasto por tipo de token (releer contexto, contexto nuevo, respuestas) y muestra qué
  herramienta llena más el contexto.
- **Simulador** incluye "¿y si…?": el mismo trabajo cotizado con otro modelo por rol.
- **Informe** arma el resumen de los últimos 7 días o del mes, listo para copiar. Se calcula en local.

## Vista ligera y segundo plano

- http://127.0.0.1:5317/?lite=1 muestra los mismos datos en vivo sin la oficina 3D (botón "Vista ligera" arriba a
  la izquierda).
- En Hábitos > Reglas > Sistema: avisos del sistema operativo, "Seguir vigilando sin pestañas" (el servidor no se
  apaga solo), la salud de la lectura y el botón para apagar el servidor.

## Si algo falla

- **Puerto 4317 o 5317 ocupado:** casi siempre es otra Colmena abierta; ciérrala y vuelve a abrir.
- **"Sin conexión":** la web no encuentra al server; revisa que siga corriendo y usa Reintentar.
- **Pantalla vacía al arrancar:** está leyendo tu historial por primera vez.
- **"Todavía no hay salas":** se muestran las sesiones abiertas y las que tuvieron movimiento hoy; revisa
  `CLAUDE_HOME`.

## Desarrollo

```powershell
npm run typecheck
npm run test
npm run build
```
