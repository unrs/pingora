package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

type result struct {
	Requests  int     `json:"requests"`
	Errors    int64   `json:"errors"`
	ElapsedMs int64   `json:"elapsedMs"`
	RPS       int     `json:"rps"`
	P50Ms     float64 `json:"p50Ms"`
	P99Ms     float64 `json:"p99Ms"`
}

func percentile(samples []float64, p float64) float64 {
	if len(samples) == 0 {
		return 0
	}
	index := int(float64(len(samples))*p+0.999999) - 1
	if index < 0 {
		index = 0
	}
	if index >= len(samples) {
		index = len(samples) - 1
	}
	return samples[index]
}

func main() {
	targetURL := flag.String("url", "", "target URL")
	duration := flag.Duration("duration", 5*time.Second, "load duration")
	concurrency := flag.Int("concurrency", 16, "concurrent clients")
	flag.Parse()

	parsedURL, err := url.Parse(*targetURL)
	if err != nil || (parsedURL.Scheme != "http" && parsedURL.Scheme != "https") || parsedURL.Host == "" ||
		*duration <= 0 || *concurrency <= 0 {
		fmt.Fprintln(os.Stderr, "-url must be an absolute http(s) URL; -duration and -concurrency must be positive")
		os.Exit(2)
	}

	transport := &http.Transport{
		MaxIdleConns:        *concurrency,
		MaxIdleConnsPerHost: *concurrency,
		DisableCompression:  true,
	}
	client := &http.Client{Transport: transport}

	ctx, cancel := context.WithTimeout(context.Background(), *duration)
	defer cancel()

	var errors atomic.Int64
	var wg sync.WaitGroup
	results := make(chan []float64, *concurrency)

	start := time.Now()
	for range *concurrency {
		wg.Add(1)
		go func() {
			defer wg.Done()
			var samples []float64
			for ctx.Err() == nil {
				req, err := http.NewRequestWithContext(ctx, http.MethodGet, *targetURL, nil)
				if err != nil {
					errors.Add(1)
					continue
				}
				started := time.Now()
				resp, err := client.Do(req)
				if err != nil {
					if ctx.Err() == nil {
						errors.Add(1)
					}
					continue
				}
				_, copyErr := io.Copy(io.Discard, resp.Body)
				_ = resp.Body.Close()
				if copyErr != nil {
					if ctx.Err() == nil {
						errors.Add(1)
					}
					continue
				}
				if resp.StatusCode != http.StatusOK {
					errors.Add(1)
					continue
				}
				samples = append(samples, float64(time.Since(started).Microseconds())/1000)
			}
			results <- samples
		}()
	}

	wg.Wait()
	close(results)
	elapsed := time.Since(start)

	var samples []float64
	for batch := range results {
		samples = append(samples, batch...)
	}
	sort.Float64s(samples)

	out := result{
		Requests:  len(samples),
		Errors:    errors.Load(),
		ElapsedMs: elapsed.Milliseconds(),
		RPS:       int(float64(len(samples)) / elapsed.Seconds()),
		P50Ms:     percentile(samples, 0.50),
		P99Ms:     percentile(samples, 0.99),
	}
	if err := json.NewEncoder(os.Stdout).Encode(out); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if out.Requests == 0 || out.Errors > 0 {
		os.Exit(1)
	}
}
