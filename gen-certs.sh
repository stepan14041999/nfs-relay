#!/usr/bin/env bash
set -euo pipefail

DIR="certs"
rm -rf "$DIR"
mkdir -p "$DIR"

# CA
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 \
  -days 3650 -nodes -keyout "$DIR/ca.key" -out "$DIR/ca.crt" \
  -subj '//CN=NFS-Relay CA'

# Function: generate key + CSR, sign with CA
gen_cert() {
  local name="$1" cn="$2"
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 \
    -nodes -keyout "$DIR/${name}.key" -out "$DIR/${name}.csr" \
    -subj "//CN=${cn}"
  openssl x509 -req -in "$DIR/${name}.csr" -CA "$DIR/ca.crt" -CAkey "$DIR/ca.key" \
    -CAcreateserial -out "$DIR/${name}.crt" -days 3650
  rm -f "$DIR/${name}.csr"
}

gen_cert "server"  "relay-server"
gen_cert "client1" "agent"
gen_cert "client2" "mounter"

rm -f "$DIR/ca.srl"
echo "Certificates generated in $DIR/"
