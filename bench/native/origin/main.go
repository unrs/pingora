package main

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
)

const payloadPath = "/data/index.html"

func main() {
	payload, err := os.ReadFile(payloadPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "origin payload unavailable:", err)
		os.Exit(1)
	}

	http.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		if os.Getenv("ORIGIN_READ_PER_REQUEST") == "1" {
			serveFile(w)
			return
		}
		w.Header().Set("Content-Length", strconv.Itoa(len(payload)))
		_, _ = w.Write(payload)
	})
	_ = http.ListenAndServe(":8080", nil)
}

func serveFile(w http.ResponseWriter) {
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

	w.Header().Set("Content-Length", strconv.FormatInt(info.Size(), 10))
	_, _ = io.Copy(w, file)
}
