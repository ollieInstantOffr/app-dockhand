package github

import (
	"context"
	"crypto"
	"crypto/hmac"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// DeviceScopes are the OAuth scopes requested by the device flow.
const DeviceScopes = "repo admin:repo_hook read:org"

// DeviceCode is the response of the device authorization request.
type DeviceCode struct {
	DeviceCode      string
	UserCode        string
	VerificationURI string
	Interval        int
	ExpiresIn       int
}

func normalizeServerURL(u string) string {
	u = strings.TrimRight(strings.TrimSpace(u), "/")
	if u == "" {
		return DefaultServerURL
	}
	return u
}

func postForm(ctx context.Context, endpoint string, form url.Values, out any) error {
	ctx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return fmt.Errorf("GitHub: build request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("User-Agent", "Dockhand")
	resp, err := sharedHTTP.Do(req)
	if err != nil {
		return fmt.Errorf("GitHub: POST %s: %w", req.URL.Path, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return errorFromResponse(resp)
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(out); err != nil {
		return fmt.Errorf("GitHub: decode %s: %w", req.URL.Path, err)
	}
	return nil
}

// StartDeviceFlow begins the OAuth device flow against serverURL
// ("https://github.com" or a GHE base URL; "" = github.com).
func StartDeviceFlow(ctx context.Context, serverURL, clientID string) (*DeviceCode, error) {
	var r struct {
		DeviceCode       string `json:"device_code"`
		UserCode         string `json:"user_code"`
		VerificationURI  string `json:"verification_uri"`
		ExpiresIn        int    `json:"expires_in"`
		Interval         int    `json:"interval"`
		Error            string `json:"error"`
		ErrorDescription string `json:"error_description"`
	}
	form := url.Values{"client_id": {clientID}, "scope": {DeviceScopes}}
	if err := postForm(ctx, normalizeServerURL(serverURL)+"/login/device/code", form, &r); err != nil {
		return nil, fmt.Errorf("start device flow: %w", err)
	}
	if r.Error != "" {
		msg := r.ErrorDescription
		if msg == "" {
			msg = r.Error
		}
		return nil, fmt.Errorf("start device flow: %w", &APIError{Status: http.StatusBadRequest, Message: msg})
	}
	if r.Interval <= 0 {
		r.Interval = 5
	}
	return &DeviceCode{
		DeviceCode:      r.DeviceCode,
		UserCode:        r.UserCode,
		VerificationURI: r.VerificationURI,
		Interval:        r.Interval,
		ExpiresIn:       r.ExpiresIn,
	}, nil
}

// PollDeviceFlow performs one token poll. status is "pending", "ok",
// "expired" or "denied"; token is set only for "ok".
func PollDeviceFlow(ctx context.Context, serverURL, clientID, deviceCode string) (string, string, error) {
	var r struct {
		AccessToken      string `json:"access_token"`
		Error            string `json:"error"`
		ErrorDescription string `json:"error_description"`
	}
	form := url.Values{
		"client_id":   {clientID},
		"device_code": {deviceCode},
		"grant_type":  {"urn:ietf:params:oauth:grant-type:device_code"},
	}
	if err := postForm(ctx, normalizeServerURL(serverURL)+"/login/oauth/access_token", form, &r); err != nil {
		return "", "", fmt.Errorf("poll device flow: %w", err)
	}
	switch r.Error {
	case "":
		if r.AccessToken == "" {
			return "", "", errors.New("poll device flow: GitHub returned no access token")
		}
		return r.AccessToken, "ok", nil
	case "authorization_pending", "slow_down":
		return "", "pending", nil
	case "expired_token":
		return "", "expired", nil
	case "access_denied":
		return "", "denied", nil
	default:
		msg := r.ErrorDescription
		if msg == "" {
			msg = r.Error
		}
		return "", "", fmt.Errorf("poll device flow: %w", &APIError{Status: http.StatusBadRequest, Message: msg})
	}
}

func parseRSAPrivateKey(pemBytes []byte) (*rsa.PrivateKey, error) {
	block, _ := pem.Decode(pemBytes)
	if block == nil {
		return nil, errors.New("GitHub App: private key is not PEM encoded")
	}
	if k, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		return k, nil
	}
	k, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("GitHub App: parse private key: %w", err)
	}
	rk, ok := k.(*rsa.PrivateKey)
	if !ok {
		return nil, errors.New("GitHub App: private key is not an RSA key")
	}
	return rk, nil
}

// AppJWT signs a GitHub App JWT (RS256, iat now-60s, exp now+9m, iss appID).
// PKCS#1 ("RSA PRIVATE KEY") and PKCS#8 ("PRIVATE KEY") PEM keys are accepted.
func AppJWT(appID int64, privateKeyPEM []byte, now time.Time) (string, error) {
	key, err := parseRSAPrivateKey(privateKeyPEM)
	if err != nil {
		return "", err
	}
	enc := base64.RawURLEncoding
	header := enc.EncodeToString([]byte(`{"alg":"RS256","typ":"JWT"}`))
	claims, err := json.Marshal(map[string]any{
		"iat": now.Add(-60 * time.Second).Unix(),
		"exp": now.Add(9 * time.Minute).Unix(),
		"iss": strconv.FormatInt(appID, 10),
	})
	if err != nil {
		return "", err
	}
	signingInput := header + "." + enc.EncodeToString(claims)
	sum := sha256.Sum256([]byte(signingInput))
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, sum[:])
	if err != nil {
		return "", fmt.Errorf("GitHub App: sign JWT: %w", err)
	}
	return signingInput + "." + enc.EncodeToString(sig), nil
}

// AppInstallationToken exchanges an App JWT for an installation access token.
func AppInstallationToken(ctx context.Context, apiURL string, appID int64, privateKeyPEM []byte, installationID int64) (string, time.Time, error) {
	jwt, err := AppJWT(appID, privateKeyPEM, time.Now())
	if err != nil {
		return "", time.Time{}, err
	}
	c := New(apiURL, jwt)
	var r struct {
		Token     string    `json:"token"`
		ExpiresAt time.Time `json:"expires_at"`
	}
	p := "/app/installations/" + strconv.FormatInt(installationID, 10) + "/access_tokens"
	if _, err := c.doJSON(ctx, http.MethodPost, p, nil, &r); err != nil {
		return "", time.Time{}, fmt.Errorf("installation token for %d: %w", installationID, err)
	}
	if r.Token == "" {
		return "", time.Time{}, fmt.Errorf("installation token for %d: empty token", installationID)
	}
	return r.Token, r.ExpiresAt, nil
}

// VerifySignature checks an X-Hub-Signature-256 header ("sha256=<hex>")
// against HMAC-SHA256(secret, body) in constant time.
func VerifySignature(secret []byte, body []byte, header string) bool {
	if len(secret) == 0 {
		return false
	}
	hexSig, ok := strings.CutPrefix(strings.TrimSpace(header), "sha256=")
	if !ok {
		return false
	}
	got, err := hex.DecodeString(hexSig)
	if err != nil || len(got) != sha256.Size {
		return false
	}
	mac := hmac.New(sha256.New, secret)
	mac.Write(body)
	return hmac.Equal(got, mac.Sum(nil))
}
