package secret

import (
	"crypto/sha256"
	"testing"
)

func TestRoundTrip(t *testing.T) {
	k := sha256.Sum256([]byte("test"))
	b, err := New(k[:])
	if err != nil {
		t.Fatal(err)
	}
	enc, err := b.Encrypt("hunter2")
	if err != nil || enc == "hunter2" {
		t.Fatal("encrypt")
	}
	if dec, err := b.Decrypt(enc); err != nil || dec != "hunter2" {
		t.Fatalf("decrypt = %q, %v", dec, err)
	}
	other := sha256.Sum256([]byte("other"))
	b2, _ := New(other[:])
	if _, err := b2.Decrypt(enc); err == nil {
		t.Error("wrong key should fail")
	}
	if e, _ := b.Encrypt(""); e != "" {
		t.Error("empty")
	}
	if s := RandomBase62(32); len(s) != 32 {
		t.Error("base62 length")
	}
}
