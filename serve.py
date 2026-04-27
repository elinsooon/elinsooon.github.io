"""Local preview server with byte-range support for PMTiles."""

import argparse
import http.server
import os
import socketserver


class RangeHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def do_GET(self):
        range_header = self.headers.get("Range")
        if not range_header:
            return super().do_GET()

        try:
            range_spec = range_header.replace("bytes=", "", 1)
            start_raw, end_raw = range_spec.split("-", 1)
            start = int(start_raw)
            end = int(end_raw) if end_raw else None
        except (AttributeError, ValueError):
            self.send_error(416, "Invalid Range")
            return

        path = self.translate_path(self.path)
        if not os.path.isfile(path):
            self.send_error(404, "File not found")
            return

        file_size = os.path.getsize(path)
        if start >= file_size:
            self.send_error(416, "Range Not Satisfiable")
            return
        if end is None or end >= file_size:
            end = file_size - 1

        content_length = end - start + 1

        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Length", str(content_length))
        self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
        self.end_headers()

        with open(path, "rb") as file:
            file.seek(start)
            self.wfile.write(file.read(content_length))


class ThreadedHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


def main():
    parser = argparse.ArgumentParser(description="Serve the portfolio locally.")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()

    print(f"Serving on http://localhost:{args.port} with byte-range support")
    ThreadedHTTPServer(("", args.port), RangeHTTPRequestHandler).serve_forever()


if __name__ == "__main__":
    main()
