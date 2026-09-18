// Package sshkeys generates and stores Dockhand's own ed25519 keypairs
// (the host-access key and the read-only git deploy key).
package sshkeys

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/pem"
	"fmt"
	"strings"

	"golang.org/x/crypto/ssh"

	"dockhand/internal/model"
	"dockhand/internal/secret"
	"dockhand/internal/settings"
)

const (
	KeyHost   = "ssh_key"
	KeyDeploy = "deploy_key"
)

type stored struct {
	PublicKey  string `json:"publicKey"`
	PrivateEnc string `json:"privateEnc"`
}

// Key is a loaded keypair.
type Key struct {
	Signer    ssh.Signer
	PublicKey string // authorized_keys line with comment
	PEM       []byte
}

// Info returns the public view.
func (k *Key) Info() model.SshKeyInfo {
	return model.SshKeyInfo{PublicKey: k.PublicKey, Fingerprint: ssh.FingerprintSHA256(k.Signer.PublicKey())}
}

// LoadOrCreate returns the keypair stored under settingsKey, generating it on first use.
func LoadOrCreate(ctx context.Context, st *settings.Store, box *secret.Box, settingsKey, comment string) (*Key, error) {
	var s stored
	found, err := st.GetRaw(ctx, settingsKey, &s)
	if err != nil {
		return nil, err
	}
	if found && s.PrivateEnc != "" {
		pemStr, err := box.Decrypt(s.PrivateEnc)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", settingsKey, err)
		}
		signer, err := ssh.ParsePrivateKey([]byte(pemStr))
		if err != nil {
			return nil, fmt.Errorf("%s: %w", settingsKey, err)
		}
		return &Key{Signer: signer, PublicKey: s.PublicKey, PEM: []byte(pemStr)}, nil
	}
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	block, err := ssh.MarshalPrivateKey(priv, comment)
	if err != nil {
		return nil, err
	}
	pemBytes := pem.EncodeToMemory(block)
	signer, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		return nil, err
	}
	sshPub, err := ssh.NewPublicKey(pub)
	if err != nil {
		return nil, err
	}
	line := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(sshPub))) + " " + comment
	enc, err := box.Encrypt(string(pemBytes))
	if err != nil {
		return nil, err
	}
	if err := st.PutRaw(ctx, settingsKey, stored{PublicKey: line, PrivateEnc: enc}); err != nil {
		return nil, err
	}
	return &Key{Signer: signer, PublicKey: line, PEM: pemBytes}, nil
}
