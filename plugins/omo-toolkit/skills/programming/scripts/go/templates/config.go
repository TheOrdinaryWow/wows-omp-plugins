// Modified-port notice: OMP adaptation of oh-my-openagent 8a8db1d3094da8743989bf693ee5de77889de50e; SUL-1.0 (see plugin LICENSE-SUL-1.0).
// Package config loads typed config from env.
package config

import (
	"time"

	"github.com/caarlos0/env/v11"
)

type Config struct {
	Host            string        `env:"HOST"             envDefault:"0.0.0.0"`
	Port            int           `env:"PORT"             envDefault:"8080"`
	ShutdownTimeout time.Duration `env:"SHUTDOWN_TIMEOUT" envDefault:"20s"`
	LogLevel        string        `env:"LOG_LEVEL"        envDefault:"info"`
	LogFormat       string        `env:"LOG_FORMAT"       envDefault:"json"`
}

func Load() (Config, error) {
	var cfg Config
	if err := env.Parse(&cfg); err != nil {
		return Config{}, err
	}
	return cfg, nil
}
