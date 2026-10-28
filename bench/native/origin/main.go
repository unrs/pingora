package main

import (
	"io"
	"net/http"
	"os"
	"strconv"
)

const payloadPath = "/data/index.html"

func main() {
	http.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		file, err := os.Open(payloadPath)
		if err != nil {
			http.Error(w, "origin payload unavailable", http.StatusInternalServerError)
			return
		}
		defer file.Close()

		info, err := file.Stat()
		if err != nil {
			http.Error(w, "origin payload unavailable", http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Content-Length", strconv.FormatInt(info.Size(), 10))
		_, _ = io.Copy(w, file)
	})
	_ = http.ListenAndServe(":8080", nil)
}
