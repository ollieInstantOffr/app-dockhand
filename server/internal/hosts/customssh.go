package hosts

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/crypto/ssh"
)

// CustomSSH is an ad-hoc SSH login to an address that isn't a Dockhand host.
type CustomSSH struct {
	Address    string
	Port       int
	User       string
	Auth       string // "key" (Dockhand's key), "password" or "privateKey"
	Password   string
	PrivateKey string // PEM/OpenSSH private key for Auth "privateKey"
	Passphrase string
	HostKey    string // expected SHA256 fingerprint; "" = accept and report it
}

// customTerm is a shell whose SSH connection belongs to it alone.
type customTerm struct {
	*sshTerm
	client *ssh.Client
}

func (t *customTerm) Close() error {
	err := t.sshTerm.Close()
	_ = t.client.Close()
	return err
}

func (t *customTerm) Wait() int {
	code := t.sshTerm.Wait()
	_ = t.client.Close()
	return code
}

// OpenCustomShell dials an arbitrary SSH server and opens a login shell on it.
// The returned DialInfo carries the server's host key fingerprint so the caller
// can remember it; a fingerprint other than c.HostKey is refused.
func (m *Manager) OpenCustomShell(ctx context.Context, c CustomSSH, cols, rows int) (Terminal, DialInfo, error) {
	c.Address = strings.TrimSpace(c.Address)
	c.User = strings.TrimSpace(c.User)
	if c.Address == "" || c.User == "" {
		return nil, DialInfo{}, errors.New("address and user are required")
	}
	if c.Port <= 0 || c.Port > 65535 {
		c.Port = 22
	}
	t := Target{Name: c.Address, Address: c.Address, Port: c.Port, User: c.User, Method: "key", HostFingerprint: strings.TrimSpace(c.HostKey)}
	switch c.Auth {
	case "password":
		if c.Password == "" {
			return nil, DialInfo{}, errors.New("enter a password")
		}
		t.Method, t.Password = "password", c.Password
	case "privateKey":
		signer, err := parseSigner(c.PrivateKey, c.Passphrase)
		if err != nil {
			return nil, DialInfo{}, err
		}
		t.Signer = signer
	}
	info, sshc, err := m.DialSSH(ctx, t, nil)
	if err != nil {
		return nil, info, err
	}
	st, err := openShell(sshc, cols, rows)
	if err != nil {
		sshc.Close()
		return nil, info, err
	}
	return &customTerm{sshTerm: st, client: sshc}, info, nil
}

func parseSigner(pem, passphrase string) (ssh.Signer, error) {
	pem = strings.TrimSpace(pem)
	if pem == "" {
		return nil, errors.New("paste a private key")
	}
	var signer ssh.Signer
	var err error
	if passphrase != "" {
		signer, err = ssh.ParsePrivateKeyWithPassphrase([]byte(pem+"\n"), []byte(passphrase))
	} else {
		signer, err = ssh.ParsePrivateKey([]byte(pem + "\n"))
	}
	var missing *ssh.PassphraseMissingError
	if errors.As(err, &missing) {
		return nil, errors.New("this private key is encrypted — enter its passphrase")
	}
	if err != nil {
		return nil, fmt.Errorf("cannot read the private key: %w", err)
	}
	return signer, nil
}
