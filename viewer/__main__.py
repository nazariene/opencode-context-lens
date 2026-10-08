import argparse
from pathlib import Path

import uvicorn

from .server import create_app
from .settings import load_settings


def main():
    parser = argparse.ArgumentParser(description="Live OpenCode V2 context dashboard")
    parser.add_argument("--settings", type=Path, default=Path("settings.yaml"))
    arguments = parser.parse_args()
    try:
        settings = load_settings(arguments.settings)
        app = create_app(settings)
    except (TypeError, ValueError, OSError) as error:
        parser.error(str(error))
    uvicorn.run(app, host=settings.host, port=settings.port, log_level="info")


if __name__ == "__main__":
    main()
