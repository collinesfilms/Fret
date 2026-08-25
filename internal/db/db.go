// Package db owns Fret's SQLite store: schema, models and every query.
package db

import (
	"context"
	"database/sql"
	_ "embed"
	"fmt"
	"path/filepath"

	_ "modernc.org/sqlite"
)

//go:embed schema.sql
var schema string

type DB struct{ *sql.DB }

// Open prepares the database file inside dir and applies the schema.
func Open(dir string) (*DB, error) {
	path := filepath.Join(dir, "fret.db")
	dsn := "file:" + path + "?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)&_pragma=synchronous(NORMAL)"
	sqldb, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	// modernc's driver is not safe for unbounded parallel writers; SQLite
	// serialises writes anyway, so a small pool avoids lock churn.
	sqldb.SetMaxOpenConns(4)
	sqldb.SetMaxIdleConns(4)

	if err := sqldb.Ping(); err != nil {
		return nil, fmt.Errorf("ping sqlite: %w", err)
	}
	if _, err := sqldb.Exec(schema); err != nil {
		return nil, fmt.Errorf("apply schema: %w", err)
	}
	return &DB{sqldb}, nil
}

// Tx runs fn inside a transaction, rolling back on error.
func (d *DB) Tx(ctx context.Context, fn func(*sql.Tx) error) error {
	tx, err := d.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		_ = tx.Rollback()
		return err
	}
	return tx.Commit()
}
