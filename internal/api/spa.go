package api

import (
	"embed"
	"io/fs"
	"net/http"
	"strings"
)

// dist holds the built frontend. It is populated by `npm run build` and baked
// into the binary at compile time, so a release is one file with no runtime
// asset dependencies.
//
//go:embed all:dist
var dist embed.FS

// spaHandler serves the frontend, falling back to index.html so client-side
// routes — including every recipient link at /<slug> — resolve on a hard load.
func (s *Server) spaHandler() http.Handler {
	root, err := fs.Sub(dist, "dist")
	if err != nil {
		s.log.Error("embedded frontend is unreadable", "error", err)
		return http.HandlerFunc(notBuilt)
	}
	index, err := fs.ReadFile(root, "index.html")
	if err != nil {
		// A binary built without running the frontend build should say so
		// plainly rather than serving a blank page.
		return http.HandlerFunc(notBuilt)
	}
	files := http.FileServer(http.FS(root))

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		clean := strings.TrimPrefix(r.URL.Path, "/")
		if clean != "" {
			if f, err := root.Open(clean); err == nil {
				if info, statErr := f.Stat(); statErr == nil && !info.IsDir() {
					f.Close()
					// Hashed asset names are immutable; index.html is not.
					if strings.HasPrefix(clean, "assets/") {
						w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
					}
					files.ServeHTTP(w, r)
					return
				}
				f.Close()
			}
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(index)
	})
}

func notBuilt(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusServiceUnavailable)
	_, _ = w.Write([]byte(`<!doctype html><meta charset="utf-8">
<title>Frontend not built</title>
<body style="font:15px/1.6 system-ui;max-width:34rem;margin:12vh auto;padding:0 1.5rem;color:#23211f">
<h1 style="font-size:1.1rem">The frontend has not been built</h1>
<p>This binary was compiled without the web assets. Build them and compile again:</p>
<pre style="background:#f4f2ee;padding:1rem;border-radius:8px;overflow-x:auto">cd web &amp;&amp; npm install &amp;&amp; npm run build
go build ./cmd/fret</pre>
<p style="color:#6d6862">The Docker image does this for you.</p>
</body>`))
}
