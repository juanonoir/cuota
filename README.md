# cuota

Un mod de Claude Code que deja siempre a la vista, en un renglón propio debajo del prompt, el modelo, el contexto y las ventanas de 5 h y 7 d del plan. Cuando algo cruza un umbral, agrega arriba del prompt una fila con la acción a mano.

```
■ 5 h al 86 % · a este ritmo llega al 100 % en ~38 min; el reset es en 1h05   1: Pasar a Sonnet  2: Ver /cuota  3: Ocultar
────────────────────────────────────────────────────────────────────────────
> _
────────────────────────────────────────────────────────────────────────────
OPUS xhigh  ·  ctx 52% █████▏░░░░  ·  ■ 5h 86%  ↻ 1h05 ▂▃▄▅▆▇  ·  7d 33%  ↻ sáb 11:00
? for shortcuts
```

Requiere Claude Code 2.1.287 o posterior. Probado en la 2.1.292.

## Instalar

En una terminal de Claude Code:

```
/plugin install cuota --marketplace juanonoir/cuota
```

Respondé `y` para agregar el marketplace y elegí el alcance de usuario. Si tenías un `statusLine` propio, la línea fija lo reemplaza: sacalo de todos los `settings.json` que lo definan, incluido el `.claude/settings.json` de la carpeta desde donde abrís `claude`, que se lee como configuración del proyecto.

## Qué muestra

**La línea fija** (siempre, en un renglón propio debajo del prompt, sobre la línea de pistas de Claude Code):

- El modelo, con un semáforo por costo: Opus rojo, Sonnet amarillo, Haiku verde. También el effort, y `fallback` si el último request salió por otro modelo.
- El contexto en %, con una barra.
- La ventana de 5 h: %, cuenta regresiva al reset y sparkline de las últimas 5 h.
- La ventana de 7 d: % y día y hora del reset.
- El caché del prompt: `●` y cuánto le queda antes de enfriarse, o `○ frío`.
- El costo de la sesión (oculto de entrada).

Si la terminal es angosta, se descartan primero el costo, el caché, el sparkline, las barras y el effort.

**Cuatro estilos**, que se eligen en `/config` (`lineStyle`) o en `/cuota` → Diseño:

| Estilo | Cómo se ve |
| --- | --- |
| compacta | `OPUS xhigh  ·  ctx 31% ███▏░░░░░░  ·  5h 42%  ↻ 2h14  ·  7d 29%  ↻ sáb 11:00  ·  caché ● 41 min` |
| píldoras | cada segmento con fondo propio; el fondo pasa a rojo cuando el segmento está en crítico |
| mínima | `OPUS   31%   42%  ↻ 2h14   29%   ●`; las etiquetas aparecen cuando algo se pone ámbar o rojo |
| dos renglones | arriba la sesión (modelo, contexto, caché, costo), abajo el plan con barras largas y el ritmo |

**Qué segmentos y en qué orden:** en `/cuota` → Diseño los tildás y los movés con ↑ ↓ mirando la vista previa de la línea real. Se guarda en el store del mod y vale para todas las sesiones. Gana el último cambio, sea del panel o de `/config`.

**Tarjeta al pasar el mouse** (terminal en pantalla completa y desktop): cada segmento muestra su detalle. El modelo muestra sus precios, el contexto qué conviene hacer, las ventanas usado contra transcurrido con su ritmo y reset, y el caché si el próximo request lo lee o lo reescribe.

**Datos del turno:** mientras Claude trabaja, el spinner suma `ctx %` y lo que lleva gastado el turno. Al cerrar, la línea «Worked for» suma los requests, la parte que salió del caché y el costo del turno.

**La fila de alerta** (arriba del prompt, sólo cuando hace falta; los dígitos funcionan escribiéndolos solos en el prompt vacío):

| Qué | Cuándo | Botones |
| --- | --- | --- |
| Contexto | ▲ desde 70 %, ■ desde 90 % | `1` Compactar · `2` Desglose · `3` Ocultar |
| Compactación | ▲ si compactar se paga en pocos turnos, o si el caché está frío | `1` Compactar · `2` Ver /cuota · `3` Ocultar |
| Ventana de 5 h | ▲ si va por encima del ritmo parejo; ■ si además pasó el 50 %, o desde 80 % | `1` Pasar a Sonnet (sólo con Opus) · `2` Ver /cuota · `3` Ocultar |
| Ventana de 7 d | Igual, con piso en 90 % | `2` Ver /cuota · `3` Ocultar |

**Además:**

- **Un aviso (toast) por ventana**, aunque tengas varias terminales abiertas. La marca queda en el store compartido del mod.
- **La línea `⚠ cuota:`** bajo el prompt mientras algo esté en rojo.
- **`/cuota`** abre un panel con pestañas (dígitos `1` a `5`) y acciones con letras (`c` compactar, `m` cambiar de modelo, `q` cerrar):
  - **Resumen:** las ventanas con ritmo y proyección, la compactación con sus números y la sesión.
  - **Contexto:** la misma grilla de colores que dibuja `/context`, con su leyenda.
  - **Ritmo:** la ventana de 5 h como gráfico de lo usado contra el tiempo, con la proyección y el ritmo parejo, y cuándo cruza el 100 %.
  - **Semana:** el mapa de calor de la semana (pico de la ventana de 5 h por hora).
  - **Diseño:** el estilo y el orden de la línea, con vista previa.

### El ritmo

`ritmo = % usado / % de la ventana transcurrido`. Un ritmo de 1,10× quiere decir que a ese paso la ventana llega al 100 % **antes** de reiniciarse. Las dos cosas son equivalentes: el ritmo pasa de 1 exactamente cuando la proyección cae antes del reset. Al principio de una ventana la proyección no es confiable, así que no avisa hasta que pasó el 20 % de la ventana o se usó el 40 %.

Las ventanas son de la cuenta, no de la sesión: el ritmo incluye tus otras sesiones y jobs en paralelo.

### Cuándo conviene compactar

Cada request vuelve a mandar todo el contexto. Compactarlo tiene un costo fijo y después ahorra en cada request. El mod hace la cuenta con los precios de lista de cada modelo; en Opus 5.5, la lectura de caché cuesta 0,05× el input, el output 5× y la escritura de caché 2× con TTL de 1 h.

- **Costo:** leer el contexto C una vez, generar el resumen S como output y guardarlo en el caché.
- **Ahorro por request:** los mensajes que el resumen reemplaza, M − S, leídos del caché.
- **M** es el contexto menos la parte fija (system prompt, herramientas, MCP), que el mod toma como el contexto más chico visto en la sesión, con tope de 60k.

La banda avisa en dos casos:

- **«Compactar se paga en ~N requests»:** cuando se paga en `compactPaybackTurns` turnos o menos. Usa la cantidad real de requests por turno, porque cada tool call reenvía el contexto.
- **«Caché frío»:** pasó más que el TTL desde la última respuesta, así que el próximo request reescribe todo el contexto al 2×. Compactar en ese momento sale casi gratis.

Cada compactación real, incluidas las automáticas, mide el tamaño del resumen y calibra la cuenta. Lo medido se guarda en el store y vale para las sesiones siguientes. El panel `/cuota` muestra los números en la sección COMPACTACIÓN.

### «Pasar a Sonnet»

El caché del prompt es de cada modelo: al cambiar, el modelo nuevo vuelve a cachear todo el contexto. Con contexto grande el botón pasa a ser **«Compactar y pasar a Sonnet»**, que compacta primero para que Sonnet cachee sólo el resumen. El panel muestra cuánto cuesta cada camino.

El cambio intenta `/model sonnet` desde el mod y comprueba si el modelo cambió. Si el motor no lo aceptó, deja `/model sonnet` escrito en el prompt para que lo confirmes con Enter.

## Configuración

`/plugin configure cuota@cuota`, o las filas del mod en `/config`:

| Opción | Default |
| --- | --- |
| `lineStyle` | `compacta` (también `pildoras`, `minima`, `dos-renglones`) |
| `ctxWarn` · `ctxCrit` | 70 · 90 |
| `fiveHourFloor` · `sevenDayFloor` | 80 · 90 |
| `compactPaybackTurns` | 2 |
| `downshiftModel` | `sonnet` |

## Desarrollo

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

`claude --plugin-dir .` carga el mod con recarga en caliente.

- `hooks/math.ts` tiene toda la aritmética y el formato, sin `$`, y se testea en `tests/math.test.ts`.
- `hooks/line.ts` arma la línea fija (segmentos, orden, estilos) y las tarjetas, también sin `$`; se testea en `tests/line.test.ts`. La línea y la vista previa del panel salen de la misma función.
- `hooks/register.tsx` tiene los hooks y el dibujo. `tests/cuota.test.ts` los prueba en terminal y desktop.

En los tests nada responde por debajo de los plugins: el helper `start()` contesta cada llamada del motor. Un hook sobre una llamada de `$` devuelve `{ value }`, un evento devuelve su resultado, y un test no puede registrar dos veces el mismo evento.

Tres reglas del motor que conviene saber:

- **`$` sólo puede pasarse a funciones declaradas en el nivel superior del archivo.** `validate` rechaza un helper que sea un closure dentro de `register`.
- **Un botón tiene 10 segundos.** Si su `onPress` espera algo más largo, como una compactación, que tarda un minuto o más, el motor lo corta y muestra `ui.press hook skipped: ran past its 10s budget`. Por eso «Compactar» sólo agenda la compactación con `$.clock.after` y vuelve enseguida.
- **Una compactación que pide el mod no pasa por el hook `session.compact` del propio mod.** `$.session.compact()` recorre todos los hooks menos los de quien llama, así que el botón lee el resultado de la llamada y calibra con eso. Las compactaciones de `/compact` y las automáticas sí pasan por el hook.

## Límites

- Las ventanas se actualizan con cada respuesta de la API. Sin turnos, el % no se mueve; la cuenta regresiva sí.
- Después de compactar, el motor no informa el contexto hasta la próxima respuesta. Mientras tanto la línea muestra el tamaño que el motor dice que quedó, y la respuesta siguiente lo corrige con la medición real, que suele ser algo mayor porque el motor vuelve a adjuntar archivos y skills.
- Un cambio de `autoCompactEnabled` o `autoCompactWindow` en `settings.json` rige para las sesiones que se abren después. Las que ya estaban abiertas siguen con la configuración con la que arrancaron.
- Fuera de suscripción no hay ventanas, y la línea muestra sólo el modelo y el contexto.
- Los mods no se dibujan en el chat de VS Code ni con `claude -p`, y las sesiones en background tampoco dibujan.
- La API de mods está en early access: si una versión nueva de Claude Code rompe algo, `claude plugin validate .` dice qué.
