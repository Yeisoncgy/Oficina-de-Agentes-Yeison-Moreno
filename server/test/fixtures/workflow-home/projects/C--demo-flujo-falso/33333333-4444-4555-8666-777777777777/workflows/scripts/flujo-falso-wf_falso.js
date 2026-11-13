// Script sintetico para las pruebas: nunca se ejecuta, solo se lee su meta.
export const meta = {
  name: 'flujo-falso',
  description: "Construye un mundo \"falso\" { con llaves }",
  // comentario con una llave suelta: {
  phases: [
    { title: 'Exploracion', detail: 'mapa del mundo', model: 'sonnet' },
    { title: "Construccion", detail: `mundo, personajes y ${'hud'}`, model: 'opus' },
    { title: `Pruebas`, detail: 'pruebas falsas' },
    { title: 'Cierre', model: 'haiku' },
  ],
};

export default async function run(ctx) {
  const { mundo } = await ctx.agent({ label: 'mundo', phase: 'Construccion' });
  return { mundo };
}
