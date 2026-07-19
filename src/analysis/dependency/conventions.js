// Exact package contracts consumed by frameworks/build tools without a source
// import. Keep them package-scope local; these are not repo-wide allowlists.
export const FRAMEWORK_RUNTIME_PEERS = new Map([
    ['next', ['react-dom']],
    ['vinext', ['@vitejs/plugin-react', '@vitejs/plugin-rsc', 'react-server-dom-webpack', 'vite']],
    ['electron-vite', ['vite']],
    ['@cloudflare/vite-plugin', ['vite', 'wrangler']],
])

// Style preprocessors are compiler inputs proven by source extensions.
export const IMPLICIT_STYLE_COMPILERS = new Map([
    ['sass', /\.(?:scss|sass)$/i],
    ['sass-embedded', /\.(?:scss|sass)$/i],
    ['less', /\.less$/i],
    ['stylus', /\.styl(?:us)?$/i],
])
