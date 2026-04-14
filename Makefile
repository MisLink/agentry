.PHONY: install uninstall decrypt
default: install

STOW_DIRS := $(filter-out pi-package/ node_modules/ skills/, $(wildcard */))

install: decrypt
	stow --target=$(HOME) -v -R $(STOW_DIRS)

uninstall:
	stow --target=$(HOME) -v -D $(STOW_DIRS)

enc_files := pi/.pi/agent/models.enc.json pi/.pi/agent/telegram.enc.json pi/.pi/agent/mcp.enc.json
decrypted_files := $(patsubst %.enc.json,%.json,$(enc_files))

$(decrypted_files): %.json: %.enc.json
	sops decrypt --output $@ $<

decrypt: $(decrypted_files)
