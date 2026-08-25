// Package storage wraps the S3 API surface Fret needs.
//
// Two clients are kept, because a self-hosted MinIO usually answers on two
// different addresses. Browser-facing URLs must be signed against the address
// the browser can reach; the server's own reads should use the LAN address,
// which is faster and avoids a round trip through the reverse proxy. When both
// endpoints are the same the two clients behave identically.
package storage

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/url"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
)

// Part size bounds. S3 allows at most 10,000 parts per upload and requires
// every part except the last to be at least 5 MiB.
const (
	MinPartSize     = 5 << 20
	basePartSize    = 16 << 20
	maxParts        = 10000
	partSafetyLimit = 9000 // leave headroom rather than landing exactly on the cap
)

type Store struct {
	// api talks to S3 from this process.
	api *s3.Client
	// presigner signs URLs the browser will use, against the public endpoint.
	presigner *s3.PresignClient
	bucket    string

	uploadTTL   time.Duration
	downloadTTL time.Duration
}

type Options struct {
	PublicEndpoint   string
	InternalEndpoint string
	Region           string
	Bucket           string
	AccessKey        string
	SecretKey        string
	ForcePathStyle   bool
	UploadTTL        time.Duration
	DownloadTTL      time.Duration
}

func New(ctx context.Context, o Options) (*Store, error) {
	build := func(endpoint string) (*s3.Client, error) {
		cfg, err := awsconfig.LoadDefaultConfig(ctx,
			awsconfig.WithRegion(o.Region),
			awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(o.AccessKey, o.SecretKey, "")),
		)
		if err != nil {
			return nil, fmt.Errorf("aws config: %w", err)
		}
		return s3.NewFromConfig(cfg, func(opt *s3.Options) {
			if endpoint != "" {
				opt.BaseEndpoint = aws.String(endpoint)
			}
			// MinIO and most self-hosted gateways serve path-style addressing.
			opt.UsePathStyle = o.ForcePathStyle
		}), nil
	}

	internal, err := build(o.InternalEndpoint)
	if err != nil {
		return nil, err
	}
	public, err := build(o.PublicEndpoint)
	if err != nil {
		return nil, err
	}
	return &Store{
		api:         internal,
		presigner:   s3.NewPresignClient(public),
		bucket:      o.Bucket,
		uploadTTL:   o.UploadTTL,
		downloadTTL: o.DownloadTTL,
	}, nil
}

// PartSizeFor picks a part size that keeps the part count comfortably under
// the S3 limit while staying large enough to be efficient on the wire.
func PartSizeFor(size int64) int64 {
	part := int64(basePartSize)
	for size/part > partSafetyLimit {
		part *= 2
	}
	if part < MinPartSize {
		part = MinPartSize
	}
	return part
}

// PartCount reports how many parts a file of this size needs.
func PartCount(size, partSize int64) int32 {
	if size <= 0 {
		return 1 // an empty object still needs one (empty) part
	}
	n := (size + partSize - 1) / partSize
	if n > maxParts {
		n = maxParts
	}
	return int32(n)
}

// Verify checks that the bucket is reachable and writable-looking at startup,
// so a misconfiguration surfaces immediately rather than on first upload.
func (s *Store) Verify(ctx context.Context) error {
	_, err := s.api.HeadBucket(ctx, &s3.HeadBucketInput{Bucket: aws.String(s.bucket)})
	if err != nil {
		return fmt.Errorf("cannot reach bucket %q: %w", s.bucket, err)
	}
	return nil
}

// StartUpload opens a multipart upload and returns its id.
func (s *Store) StartUpload(ctx context.Context, key, filename, contentType string) (string, error) {
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	out, err := s.api.CreateMultipartUpload(ctx, &s3.CreateMultipartUploadInput{
		Bucket:             aws.String(s.bucket),
		Key:                aws.String(key),
		ContentType:        aws.String(contentType),
		ContentDisposition: aws.String(contentDisposition(filename)),
	})
	if err != nil {
		return "", fmt.Errorf("create multipart upload: %w", err)
	}
	return aws.ToString(out.UploadId), nil
}

// PresignPart returns a URL the browser PUTs one part to, going straight to
// S3 without passing through this server.
func (s *Store) PresignPart(ctx context.Context, key, uploadID string, partNumber int32) (string, error) {
	req, err := s.presigner.PresignUploadPart(ctx, &s3.UploadPartInput{
		Bucket:     aws.String(s.bucket),
		Key:        aws.String(key),
		UploadId:   aws.String(uploadID),
		PartNumber: aws.Int32(partNumber),
	}, s3.WithPresignExpires(s.uploadTTL))
	if err != nil {
		return "", fmt.Errorf("presign part %d: %w", partNumber, err)
	}
	return req.URL, nil
}

// CompletedPart pairs a part number with the ETag S3 returned for it.
type CompletedPart struct {
	PartNumber int32
	ETag       string
}

// FinishUpload assembles the parts into the final object.
func (s *Store) FinishUpload(ctx context.Context, key, uploadID string, parts []CompletedPart) error {
	completed := make([]types.CompletedPart, len(parts))
	for i, p := range parts {
		completed[i] = types.CompletedPart{
			PartNumber: aws.Int32(p.PartNumber),
			ETag:       aws.String(p.ETag),
		}
	}
	_, err := s.api.CompleteMultipartUpload(ctx, &s3.CompleteMultipartUploadInput{
		Bucket:          aws.String(s.bucket),
		Key:             aws.String(key),
		UploadId:        aws.String(uploadID),
		MultipartUpload: &types.CompletedMultipartUpload{Parts: completed},
	})
	if err != nil {
		return fmt.Errorf("complete multipart upload: %w", err)
	}
	return nil
}

// AbortUpload discards an unfinished upload and the storage its parts hold.
func (s *Store) AbortUpload(ctx context.Context, key, uploadID string) error {
	_, err := s.api.AbortMultipartUpload(ctx, &s3.AbortMultipartUploadInput{
		Bucket:   aws.String(s.bucket),
		Key:      aws.String(key),
		UploadId: aws.String(uploadID),
	})
	if err != nil && !isMissing(err) {
		return fmt.Errorf("abort multipart upload: %w", err)
	}
	return nil
}

// PutEmpty writes a zero-byte object, which multipart cannot express.
func (s *Store) PutEmpty(ctx context.Context, key, filename string) error {
	_, err := s.api.PutObject(ctx, &s3.PutObjectInput{
		Bucket:             aws.String(s.bucket),
		Key:                aws.String(key),
		Body:               strings.NewReader(""),
		ContentLength:      aws.Int64(0),
		ContentDisposition: aws.String(contentDisposition(filename)),
	})
	if err != nil {
		return fmt.Errorf("put empty object: %w", err)
	}
	return nil
}

// PresignDownload returns a short-lived URL for a single file, with the
// download filename set so the recipient does not receive an opaque key.
func (s *Store) PresignDownload(ctx context.Context, key, filename string) (string, error) {
	req, err := s.presigner.PresignGetObject(ctx, &s3.GetObjectInput{
		Bucket:                     aws.String(s.bucket),
		Key:                        aws.String(key),
		ResponseContentDisposition: aws.String(contentDisposition(filename)),
	}, s3.WithPresignExpires(s.downloadTTL))
	if err != nil {
		return "", fmt.Errorf("presign download: %w", err)
	}
	return req.URL, nil
}

// Open streams an object for the server's own use, over the internal
// endpoint. This is the read side of a zip stream.
func (s *Store) Open(ctx context.Context, key string) (io.ReadCloser, error) {
	out, err := s.api.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return nil, fmt.Errorf("get object %q: %w", key, err)
	}
	return out.Body, nil
}

// Delete removes objects. Missing keys are not an error: deletion should be
// idempotent so a partially-completed sweep can simply run again.
func (s *Store) Delete(ctx context.Context, keys []string) error {
	if len(keys) == 0 {
		return nil
	}
	// DeleteObjects accepts 1000 keys per call.
	for start := 0; start < len(keys); start += 1000 {
		end := min(start+1000, len(keys))
		batch := make([]types.ObjectIdentifier, 0, end-start)
		for _, k := range keys[start:end] {
			batch = append(batch, types.ObjectIdentifier{Key: aws.String(k)})
		}
		_, err := s.api.DeleteObjects(ctx, &s3.DeleteObjectsInput{
			Bucket: aws.String(s.bucket),
			Delete: &types.Delete{Objects: batch, Quiet: aws.Bool(true)},
		})
		if err != nil && !isMissing(err) {
			return fmt.Errorf("delete objects: %w", err)
		}
	}
	return nil
}

// Usage totals the bucket. It walks every object, so callers should cache the
// result rather than asking on each page load.
func (s *Store) Usage(ctx context.Context) (bytes int64, objects int64, err error) {
	p := s3.NewListObjectsV2Paginator(s.api, &s3.ListObjectsV2Input{Bucket: aws.String(s.bucket)})
	for p.HasMorePages() {
		page, err := p.NextPage(ctx)
		if err != nil {
			return 0, 0, fmt.Errorf("list objects: %w", err)
		}
		for _, o := range page.Contents {
			bytes += aws.ToInt64(o.Size)
			objects++
		}
	}
	return bytes, objects, nil
}

// OrphanedUpload is a multipart upload S3 still holds that Fret no longer
// tracks — the residue of a browser that vanished mid-transfer.
type OrphanedUpload struct {
	Key       string
	UploadID  string
	Initiated time.Time
}

// ListOrphans finds multipart uploads started before the cutoff.
func (s *Store) ListOrphans(ctx context.Context, before time.Time) ([]OrphanedUpload, error) {
	var out []OrphanedUpload
	var keyMarker, idMarker *string
	for {
		page, err := s.api.ListMultipartUploads(ctx, &s3.ListMultipartUploadsInput{
			Bucket:         aws.String(s.bucket),
			KeyMarker:      keyMarker,
			UploadIdMarker: idMarker,
		})
		if err != nil {
			return nil, fmt.Errorf("list multipart uploads: %w", err)
		}
		for _, u := range page.Uploads {
			initiated := aws.ToTime(u.Initiated)
			if initiated.Before(before) {
				out = append(out, OrphanedUpload{
					Key:       aws.ToString(u.Key),
					UploadID:  aws.ToString(u.UploadId),
					Initiated: initiated,
				})
			}
		}
		if !aws.ToBool(page.IsTruncated) {
			return out, nil
		}
		keyMarker, idMarker = page.NextKeyMarker, page.NextUploadIdMarker
	}
}

// contentDisposition builds a header that survives non-ASCII filenames, using
// the RFC 5987 form alongside a stripped-down fallback for old clients.
func contentDisposition(filename string) string {
	ascii := strings.Map(func(r rune) rune {
		if r < 32 || r > 126 || r == '"' || r == '\\' {
			return '_'
		}
		return r
	}, filename)
	if ascii == "" {
		ascii = "download"
	}
	return fmt.Sprintf(`attachment; filename="%s"; filename*=UTF-8''%s`, ascii, url.PathEscape(filename))
}

func isMissing(err error) bool {
	var nsk *types.NoSuchKey
	var nsu *types.NoSuchUpload
	if errors.As(err, &nsk) || errors.As(err, &nsu) {
		return true
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "notfound") || strings.Contains(msg, "nosuchkey") || strings.Contains(msg, "nosuchupload")
}
