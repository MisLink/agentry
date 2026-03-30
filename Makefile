.PHONY: install uninstall decrypt

STOW_DIRS := $(filter-out pi-package/ node_modules/, $(wildcard */))

install: decrypt
	stow --target=$(HOME) -v -R $(STOW_DIRS)

uninstall:
	stow --target=$(HOME) -v -D $(STOW_DIRS)

decrypt:
	sops decrypt pi/.pi/agent/models.enc.json > pi/.pi/agent/models.json
