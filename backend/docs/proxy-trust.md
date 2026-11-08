# Reverse-proxy trust configuration

The backend does not assume that one network hop is a trusted proxy. Express
trusts no forwarded addresses unless `TRUSTED_PROXY_CIDRS` is explicitly set
to comma-separated IP addresses or CIDR ranges for the immediate ingress
proxies. The values must describe the actual socket peer that connects to this
process, not the client addresses carried in `X-Forwarded-For`.

No hosting or ingress configuration in this repository establishes the
production proxy addresses or proves that the backend cannot be reached
directly. Therefore, the production trust boundary remains an operator
requirement: verify the ingress topology, restrict direct backend access at the
network layer, then configure the exact proxy CIDRs. Until that is done,
Express uses the direct peer address and ignores `X-Forwarded-For`; this is
spoof-resistant but may collapse users behind the proxy onto one observed IP.
Do not replace the explicit CIDR list with a hop count.
