# Publicar Aleja & Alejo

## 1. Supabase

1. Crea un proyecto en Supabase.
2. En el SQL Editor, ejecuta el contenido de `supabase-schema.sql`.
3. Copia tu Project URL y Publishable key.
4. Para probar local, crea `.env.local` con:

```env
VITE_SUPABASE_URL=https://tu-proyecto.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=tu_publishable_key_o_anon_key
```

5. Reinicia la app local con `npm.cmd run dev`.

Si Supabase esta vacio y este navegador tiene datos locales, la app sube esos datos la primera vez.

## 2. GitHub Pages

1. Sube este proyecto a un repositorio de GitHub.
2. En GitHub, ve a Settings > Secrets and variables > Actions.
3. Crea estos secrets:

```text
VITE_SUPABASE_URL
VITE_SUPABASE_PUBLISHABLE_KEY
```

4. Ve a Settings > Pages y selecciona GitHub Actions como fuente.
5. Haz push a la rama `main`.

El workflow `.github/workflows/pages.yml` publica la carpeta `gh-pages-dist`.

## Comandos utiles

```bash
npm.cmd run dev
npm.cmd run build
npm.cmd run build:pages
```
