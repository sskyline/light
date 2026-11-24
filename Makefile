.PHONY: build debug run test smoke clean

build:
	./scripts/build.sh release

debug:
	./scripts/build.sh debug

run:
	./scripts/dev.sh

test:
	swift build && swift run --skip-build LightTests

smoke: build
	./scripts/smoke.sh

clean:
	rm -rf .build release/macos/Light.app
