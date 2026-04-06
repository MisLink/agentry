.PHONY: install uninstall decrypt

STOW_DIRS := $(filter-out pi-package/ node_modules/, $(wildcard */))

install: decrypt
	stow --target=$(HOME) -v -R $(STOW_DIRS)

uninstall:
	stow --target=$(HOME) -v -D $(STOW_DIRS)

enc_files := pi/.pi/agent/models.enc.json pi/.pi/agent/telegram.enc.json
decrypted_files := $(patsubst %.enc.json,%.json,$(enc_files))

$(decrypted_files): %.json: %.enc.json
	sops decrypt $< > $@

decrypt: $(decrypted_files)
