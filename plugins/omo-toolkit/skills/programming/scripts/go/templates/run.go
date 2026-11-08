// Modified-port notice: OMP adaptation of oh-my-openagent adddd17004076e799c2de18ccfdee29e12525ace; SUL-1.0 (see plugin LICENSE-SUL-1.0).
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
