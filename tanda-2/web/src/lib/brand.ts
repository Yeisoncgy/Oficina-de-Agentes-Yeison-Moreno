/** Nombre de la herramienta y credito: salen en la barra de arriba, la pestana y la pantalla de carga */
export const APP_NAME = 'Colmena';
export const APP_TAGLINE = 'Tus agentes trabajando';
export const APP_CREDIT = 'Herramienta personal';

/** pestana del navegador: solo el nombre, y cuantos agentes hay activos si hay alguno */
export function tabTitle(working: number): string {
  if (working <= 0) return APP_NAME;
  return `${APP_NAME} · ${working} ${working === 1 ? 'activo' : 'activos'}`;
}
