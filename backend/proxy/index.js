import http from "http";
import https from "https";
import url from "url";
import { ethers } from "ethers";

const PORT = process.env.PORT || 8545;

// Configuration with defaults
const config = {
  targetRpcUrl:
    process.env.TARGET_RPC_URL ||
    "https://sepolia.infura.io/v3/d1d7ac2015e14aa7928d885d1b6e06c0",
  relayUrl: process.env.RELAY_URL || "http://localhost:8080/api/v1/simulate",
  chainId: process.env.CHAIN_ID || "11155111",
};

// Parse the target URL once
const targetUrlParsed = new URL(config.targetRpcUrl);

// Create HTTP server
const server = http.createServer((req, res) => {
  console.log(
    `[${new Date().toISOString()}] Received ${req.method} request for ${
      req.url
    }`
  );

  // Only handle POST requests to the root path
  if (req.method !== "POST" || req.url !== "/") {
    console.log("Not a POST to root, sending 405");
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32700, message: "Method not allowed" },
        id: null,
      })
    );
    return;
  }

  // Collect request body data
  let body = "";
  req.on("data", (chunk) => {
    body += chunk.toString();
  });

  req.on("end", async () => {
    // console.log("Request body:", body);

    // Parse JSON body
    let rpcRequest;
    try {
      rpcRequest = JSON.parse(body);
      //console.log("Parsed RPC request:", rpcRequest);
    } catch (error) {
      console.error("Failed to parse JSON:", error.message);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32700, message: "Parse error - Invalid JSON" },
          id: null,
        })
      );
      return;
    }

    // Check if this is eth_sendTransaction
    if (rpcRequest.method === "eth_sendRawTransaction") {
      console.log("Intercepted eth_sendRawTransaction:", rpcRequest.params[0]);

      // Relay transaction details (non-blocking)
      try {
        const rawTx = rpcRequest.params[0];
        let decodedTx;
        try {
          decodedTx = ethers.Transaction.from(rawTx);
        } catch (err) {
          console.error("Failed to decode raw transaction:", err.message);
          decodedTx = null;
        }

        let relayBody;
        if (decodedTx) {
          // Fetch current block number using ethers.js
          const provider = new ethers.JsonRpcProvider(config.targetRpcUrl);
          let blockNumber = null;
          try {
            blockNumber = await provider.getBlockNumber();
          } catch (err) {
            console.error("Failed to fetch block number:", err.message);
          }
          relayBody = {
            chainId: parseInt(decodedTx.chainId),
            from: decodedTx.from,
            to: decodedTx.to || "0x0000000000000000000000000000000000000000",
            data: decodedTx.data,
            gasLimit: parseInt(decodedTx.gasLimit),
            value: decodedTx.value.toString(),
            blockNumber: blockNumber,
          };
        } else {
          relayBody = { error: "Failed to decode raw transaction" };
        }

        const relayBodyString = JSON.stringify(relayBody);

        const relayRequest = http.request(config.relayUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(relayBodyString),
          },
        });
        relayRequest.on("error", (error) => {
          console.error("Error relaying transaction:", error.message);
        });

        relayRequest.on("response", (relayRes) => {
          let relayData = "";
          relayRes.on("data", (chunk) => {
            relayData += chunk;
          });
          relayRes.on("end", () => {
            console.log("Relay server response:", relayData);
          });
        });

        console.log("Relaying transaction:", relayBody);
        relayRequest.write(relayBodyString);
        relayRequest.end();
      } catch (error) {
        console.error("Failed to relay transaction:", error.message);
        // Continue processing even if relay fails
      }
      // Do not forward eth_sendRawTransaction to the target RPC node
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: rpcRequest.id,
          result: "Relayed eth_sendRawTransaction, not forwarded to RPC node",
        })
      );
      return;
    }

    // Forward to the target RPC node
    const options = {
      method: "POST",
      hostname: targetUrlParsed.hostname,
      port:
        targetUrlParsed.port ||
        (targetUrlParsed.protocol === "https:" ? 443 : 80),
      path: targetUrlParsed.pathname,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    };

    // Choose http or https module based on protocol
    const requester = targetUrlParsed.protocol === "https:" ? https : http;

    console.log(`Forwarding to ${targetUrlParsed.href}`);

    const proxyReq = requester.request(options, (proxyRes) => {
      console.log(
        "Received response from target with status:",
        proxyRes.statusCode
      );

      // Set response headers
      res.writeHead(proxyRes.statusCode, proxyRes.headers);

      // Forward the response data
      proxyRes.pipe(res);
    });

    proxyReq.on("error", (error) => {
      console.error("Error forwarding request:", error.message);
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal error - proxy failure",
            data: error.message,
          },
          id: rpcRequest.id,
        })
      );
    });

    // Write the request body to the proxy request
    proxyReq.write(body);
    proxyReq.end();
  });
});

// Handle server errors
server.on("error", (error) => {
  console.error("Server error:", error.message);
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Try a different port.`);
    process.exit(1);
  }
});

// Start the server
server.listen(PORT, () => {
  console.log(`RPC proxy server running on port ${PORT}`);
  console.log(`Proxying requests to: ${config.targetRpcUrl}`);
  console.log(`Relaying eth_sendTransaction calls to: ${config.relayUrl}`);
});
