// Modified-port notice: OMP adaptation of oh-my-openagent 8a8db1d3094da8743989bf693ee5de77889de50e; SUL-1.0 (see plugin LICENSE-SUL-1.0).
// Package cmd wires the root command and subcommands.
package cmd

import (
	"context"
	"log/slog"
	"os"
)

// Execute runs the root command. Wire cobra/subcommands here.
func Execute(ctx context.Context) error {
	slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.InfoContext(ctx, "starting")
	return nil
}
