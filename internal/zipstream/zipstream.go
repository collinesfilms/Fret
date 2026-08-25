// Package zipstream writes a zip64 archive straight to an io.Writer without
// buffering, compressing, or touching disk.
//
// Every entry is stored, never deflated. Fret's payload is finished media —
// ProRes, H.264, PNG, WAV — which compresses by approximately nothing, so
// DEFLATE would burn CPU to produce a slightly larger file. Storing makes the
// archive a thin envelope around bytes that are copied verbatim, which means
// three useful things:
//
//   - CPU cost collapses to one CRC32 pass, which runs faster than any network
//     that could be feeding it.
//   - Memory is one buffer regardless of payload; a 100 GB archive costs the
//     same as a 100 MB one.
//   - The finished size is computable in advance from the file list alone (see
//     Size), so the response carries a real Content-Length. The recipient gets
//     a true progress bar and an ETA instead of an indefinite spinner.
//
// Sizes are known up front but CRC32 values are not, so each entry uses a
// trailing data descriptor. That costs a fixed 24 bytes per file and keeps the
// output fully streamable.
package zipstream

import (
	"context"
	"encoding/binary"
	"fmt"
	"hash/crc32"
	"io"
	"strings"
	"time"
)

// Fixed on-disk sizes of the structures this package emits.
const (
	localHeaderBase   = 30 // signature through extra-field length
	zip64LocalExtra   = 20 // 4-byte header + two 8-byte sizes
	dataDescriptor    = 24 // signature, CRC, two 8-byte sizes
	centralHeaderBase = 46
	zip64CentralExtra = 28 // 4-byte header + two sizes + local header offset
	zip64EOCDRecord   = 56
	zip64EOCDLocator  = 20
	endOfCentralDir   = 22
)

const (
	sigLocalHeader    = 0x04034b50
	sigDataDescriptor = 0x08074b50
	sigCentralHeader  = 0x02014b50
	sigZip64EOCD      = 0x06064b50
	sigZip64Locator   = 0x07064b50
	sigEOCD           = 0x06054b50

	versionZip64 = 45     // 4.5, the minimum that understands zip64
	flagStreamed = 0x0008 // sizes and CRC follow the data
	flagUTF8     = 0x0800 // names are UTF-8, not CP437
	methodStore  = 0

	uint32Max = 0xFFFFFFFF
	uint16Max = 0xFFFF
)

// Entry describes one file to place in the archive.
type Entry struct {
	Name     string // display name, already flattened and de-duplicated
	Size     int64
	Modified time.Time
}

// Opener supplies the bytes for entries[i]. The returned reader is closed by
// Stream. It must yield exactly Entry.Size bytes.
type Opener func(ctx context.Context, index int) (io.ReadCloser, error)

// Size returns the exact number of bytes Stream will write for these entries.
// Call it to set Content-Length before streaming a single byte.
func Size(entries []Entry) int64 {
	var total int64
	for _, e := range entries {
		n := int64(len(zipName(e.Name)))
		total += localHeaderBase + n + zip64LocalExtra // local file header
		total += e.Size                                // stored, so verbatim
		total += dataDescriptor                        // trailing CRC and sizes
		total += centralHeaderBase + n + zip64CentralExtra
	}
	return total + zip64EOCDRecord + zip64EOCDLocator + endOfCentralDir
}

// Stream writes the complete archive to w.
//
// The write is unbuffered and strictly forward-only: it never seeks, so it is
// safe to pass an http.ResponseWriter directly. If a source yields the wrong
// number of bytes the stream is aborted mid-flight, because continuing would
// contradict the Content-Length already sent.
func Stream(ctx context.Context, w io.Writer, entries []Entry, open Opener) error {
	cw := &countingWriter{w: w}
	directory := make([]centralEntry, 0, len(entries))

	for i, e := range entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		name := zipName(e.Name)
		offset := cw.n
		modTime, modDate := dosTime(e.Modified)

		if err := writeLocalHeader(cw, name, modTime, modDate); err != nil {
			return fmt.Errorf("entry %d header: %w", i, err)
		}

		crc, err := copyEntry(ctx, cw, open, i, e.Size)
		if err != nil {
			return err
		}

		if err := writeDataDescriptor(cw, crc, e.Size); err != nil {
			return fmt.Errorf("entry %d descriptor: %w", i, err)
		}
		directory = append(directory, centralEntry{
			name: name, size: e.Size, crc: crc, offset: offset,
			modTime: modTime, modDate: modDate,
		})
	}

	return writeDirectory(cw, directory)
}

// copyEntry streams one file through, hashing as it goes, and insists on the
// exact declared length in both directions.
func copyEntry(ctx context.Context, w io.Writer, open Opener, index int, size int64) (uint32, error) {
	rc, err := open(ctx, index)
	if err != nil {
		return 0, fmt.Errorf("entry %d open: %w", index, err)
	}
	defer rc.Close()

	hasher := crc32.NewIEEE()
	written, err := io.CopyN(io.MultiWriter(w, hasher), rc, size)
	if err == io.EOF && written < size {
		return 0, fmt.Errorf("entry %d truncated: %d of %d bytes", index, written, size)
	}
	if err != nil {
		return 0, fmt.Errorf("entry %d copy: %w", index, err)
	}
	// A source longer than declared would push the response past its
	// Content-Length, so treat any trailing byte as a hard error.
	if extra, _ := io.CopyN(io.Discard, rc, 1); extra > 0 {
		return 0, fmt.Errorf("entry %d longer than the declared %d bytes", index, size)
	}
	return hasher.Sum32(), nil
}

type centralEntry struct {
	name             string
	size             int64
	crc              uint32
	offset           int64
	modTime, modDate uint16
}

func writeLocalHeader(w io.Writer, name string, modTime, modDate uint16) error {
	buf := make([]byte, 0, localHeaderBase+len(name)+zip64LocalExtra)
	buf = le32(buf, sigLocalHeader)
	buf = le16(buf, versionZip64)
	buf = le16(buf, flagStreamed|flagUTF8)
	buf = le16(buf, methodStore)
	buf = le16(buf, modTime)
	buf = le16(buf, modDate)
	buf = le32(buf, 0)         // CRC follows in the data descriptor
	buf = le32(buf, uint32Max) // compressed size: see zip64 extra
	buf = le32(buf, uint32Max) // uncompressed size: see zip64 extra
	buf = le16(buf, uint16(len(name)))
	buf = le16(buf, zip64LocalExtra)
	buf = append(buf, name...)
	// Zip64 extended information. Values are unknown here and land in the
	// data descriptor, but the field must be present for the sizes above.
	buf = le16(buf, 0x0001)
	buf = le16(buf, 16)
	buf = le64(buf, 0)
	buf = le64(buf, 0)
	_, err := w.Write(buf)
	return err
}

func writeDataDescriptor(w io.Writer, crc uint32, size int64) error {
	buf := make([]byte, 0, dataDescriptor)
	buf = le32(buf, sigDataDescriptor)
	buf = le32(buf, crc)
	buf = le64(buf, uint64(size)) // compressed == uncompressed when stored
	buf = le64(buf, uint64(size))
	_, err := w.Write(buf)
	return err
}

func writeDirectory(cw *countingWriter, entries []centralEntry) error {
	start := cw.n
	for _, e := range entries {
		buf := make([]byte, 0, centralHeaderBase+len(e.name)+zip64CentralExtra)
		buf = le32(buf, sigCentralHeader)
		buf = le16(buf, versionZip64|(3<<8)) // made by Unix
		buf = le16(buf, versionZip64)
		buf = le16(buf, flagStreamed|flagUTF8)
		buf = le16(buf, methodStore)
		buf = le16(buf, e.modTime)
		buf = le16(buf, e.modDate)
		buf = le32(buf, e.crc)
		buf = le32(buf, uint32Max) // compressed size in zip64 extra
		buf = le32(buf, uint32Max) // uncompressed size in zip64 extra
		buf = le16(buf, uint16(len(e.name)))
		buf = le16(buf, zip64CentralExtra)
		buf = le16(buf, 0) // comment length
		buf = le16(buf, 0) // disk number start
		buf = le16(buf, 0) // internal attributes
		buf = le32(buf, 0o644<<16)
		buf = le32(buf, uint32Max) // local header offset in zip64 extra
		buf = append(buf, e.name...)
		buf = le16(buf, 0x0001)
		buf = le16(buf, 24)
		buf = le64(buf, uint64(e.size))
		buf = le64(buf, uint64(e.size))
		buf = le64(buf, uint64(e.offset))
		if _, err := cw.Write(buf); err != nil {
			return fmt.Errorf("central directory: %w", err)
		}
	}
	size := cw.n - start

	buf := make([]byte, 0, zip64EOCDRecord+zip64EOCDLocator+endOfCentralDir)
	// Zip64 end of central directory record.
	buf = le32(buf, sigZip64EOCD)
	buf = le64(buf, zip64EOCDRecord-12) // size of the remainder of this record
	buf = le16(buf, versionZip64|(3<<8))
	buf = le16(buf, versionZip64)
	buf = le32(buf, 0) // this disk
	buf = le32(buf, 0) // disk holding the directory
	buf = le64(buf, uint64(len(entries)))
	buf = le64(buf, uint64(len(entries)))
	buf = le64(buf, uint64(size))
	buf = le64(buf, uint64(start))
	// Zip64 end of central directory locator.
	buf = le32(buf, sigZip64Locator)
	buf = le32(buf, 0)
	buf = le64(buf, uint64(start+size))
	buf = le32(buf, 1)
	// Legacy end of central directory, with every field saturated so readers
	// that only understand the old record follow the zip64 one instead.
	buf = le32(buf, sigEOCD)
	buf = le16(buf, 0)
	buf = le16(buf, 0)
	buf = le16(buf, uint16Max)
	buf = le16(buf, uint16Max)
	buf = le32(buf, uint32Max)
	buf = le32(buf, uint32Max)
	buf = le16(buf, 0)

	_, err := cw.Write(buf)
	return err
}

// zipName makes a display name safe as an archive path: forward slashes only,
// no leading separator, no parent traversal.
//
// Traversal is removed segment by segment rather than by substring. Deleting
// every "../" in one pass is not enough — "....//" collapses back into a live
// "../" as the surrounding characters close up.
func zipName(name string) string {
	name = strings.ReplaceAll(name, "\\", "/")
	name = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, name)

	segments := strings.Split(name, "/")
	kept := segments[:0]
	for _, seg := range segments {
		// Trailing dots and spaces are stripped by Windows on extraction,
		// which would silently turn a name like "...." into nothing.
		seg = strings.TrimRight(strings.TrimSpace(seg), ". ")
		if seg == "" {
			continue
		}
		kept = append(kept, seg)
	}
	if len(kept) == 0 {
		return "file"
	}
	return strings.Join(kept, "/")
}

// dosTime converts a timestamp to the MS-DOS pair the zip format stores.
func dosTime(t time.Time) (dosTime, dosDate uint16) {
	if t.IsZero() || t.Year() < 1980 {
		t = time.Date(1980, 1, 1, 0, 0, 0, 0, time.UTC)
	}
	t = t.UTC()
	dosTime = uint16(t.Second()/2) | uint16(t.Minute())<<5 | uint16(t.Hour())<<11
	dosDate = uint16(t.Day()) | uint16(t.Month())<<5 | uint16(t.Year()-1980)<<9
	return
}

type countingWriter struct {
	w io.Writer
	n int64
}

func (c *countingWriter) Write(p []byte) (int, error) {
	n, err := c.w.Write(p)
	c.n += int64(n)
	return n, err
}

func le16(b []byte, v uint16) []byte { return binary.LittleEndian.AppendUint16(b, v) }
func le32(b []byte, v uint32) []byte { return binary.LittleEndian.AppendUint32(b, v) }
func le64(b []byte, v uint64) []byte { return binary.LittleEndian.AppendUint64(b, v) }
