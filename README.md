# cuota

Un mod de Claude Code que deja siempre a la vista, arriba del prompt, el modelo, el contexto y las ventanas de 5 h y 7 d del plan. Cuando algo cruza un umbral, agrega una fila con la acción a mano.

```
■ 5 h al 86 % · a este ritmo llega al 100 % en ~38 min; el reset es en 1h05   1: Pasar a Sonnet  2: Ver /cuota  3: Ocultar
OPUS xhigh  ·  ctx 52% █████▏░░░░  ·  ■ 5h 86% ↻1h05 ▂▃▄▅▆▇  ·  7d 33% ↻sáb 11:00
```

Requiere Claude Code 2.1.287 o posterior. Probado en la 2.1.292.

## Instalar

En una terminal de Claude Code:

```
/plugin install cuota --marketplace juanonoir/cuota
```

Respondé `y` para agregar el marketplace y elegí el alcance de usuario. Si tenías un `statusLine` propio en `settings.json`, la banda lo reemplaza: podés sacarlo.

## Qué muestra

**La línea fija** (siempre):

- El modelo, con un semáforo por costo: Opus rojo, Sonnet amarillo, Haiku verde. También el effort, y `fallback` si el último request salió por otro modelo.
- El contexto en %, con una barra.
- La ventana de 5 h: %, cuenta regresiva al reset y sparkline de las últimas 5 h.
- La ventana de 7 d: % y día y hora del reset.

Si la banda es angosta, se descartan primero el sparkline, las barras y el effort.

**La fila de alerta** (sólo cuando hace falta):

| Qué | Cuándo | Botones |
| --- | --- | --- |
| Contexto | ▲ desde 70 %, ■ desde 90 % | `1` Compactar · `2` Desglose · `3` Ocultar |
| Ventana de 5 h | ▲ si va por encima del ritmo parejo; ■ si además pasó el 50 %, o desde 80 % | `1` Pasar a Sonnet (sólo con Opus) · `2` Ver /cuota · `3` Ocultar |
| Ventana de 7 d | Igual, con piso en 90 % | `2` Ver /cuota · `3` Ocultar |

Los dígitos funcionan escribiéndolos solos en el prompt vacío.

**Además:**

- **Un aviso (toast) por ventana**, aunque tengas varias terminales abiertas. La marca queda en el store compartido del mod.
- **La línea `⚠ cuota:`** bajo el prompt mientras algo esté en rojo.
- **`/cuota`** abre un panel con:
  - el desglose del contexto;
  - las ventanas con su ritmo y proyección;
  - el ritmo de las últimas 5 h;
  - un mapa de calor de la semana (pico de la ventana de 5 h por hora);
  - la sesión: modelo, duración, turnos y costo equivalente API.

### El ritmo

`ritmo = % usado / % de la ventana transcurrido`. Un ritmo de 1,10× quiere decir que a ese paso la ventana llega al 100 % **antes** de reiniciarse. Las dos cosas son equivalentes: el ritmo pasa de 1 exactamente cuando la proyección cae antes del reset. Al principio de una ventana la proyección no es confiable, así que no avisa hasta que pasó el 20 % de la ventana o se usó el 40 %.

Las ventanas son de la cuenta, no de la sesión: el ritmo incluye tus otras sesiones y jobs en paralelo.

### «Pasar a Sonnet»

El botón intenta `/model sonnet` desde el mod y comprueba si el modelo cambió. Si el motor no lo aceptó, deja `/model sonnet` escrito en el prompt para que lo confirmes con Enter.

## Configuración

`/plugin configure cuota@cuota`, o las filas del mod en `/config`:

| Opción | Default |
| --- | --- |
| `ctxWarn` · `ctxCrit` | 70 · 90 |
| `fiveHourFloor` · `sevenDayFloor` | 80 · 90 |
| `downshiftModel` | `sonnet` |

## Desarrollo

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

`claude --plugin-dir .` carga el mod con recarga en caliente.

- `hooks/math.ts` tiene toda la aritmética y el formato, sin `$`, y se testea en `tests/math.test.ts`.
- `hooks/register.tsx` tiene los hooks y el dibujo. `tests/cuota.test.ts` los prueba en terminal y desktop.

Una regla del motor que conviene saber: **`$` sólo puede pasarse a funciones declaradas en el nivel superior del archivo**. `validate` rechaza un helper que sea un closure dentro de `register`.

## Límites

- Las ventanas se actualizan con cada respuesta de la API. Sin turnos, el % no se mueve; la cuenta regresiva sí.
- Fuera de suscripción no hay ventanas, y la línea muestra sólo el modelo y el contexto.
- Los mods no se dibujan en el chat de VS Code ni con `claude -p`, y las sesiones en background tampoco dibujan.
- La API de mods está en early access: si una versión nueva de Claude Code rompe algo, `claude plugin validate .` dice qué.
