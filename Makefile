.PHONY: install uninstall decrypt skills
default: install

STOW_DIRS := agents claude pi
IGNORE_REGEXS := \.DS_Store .+\.enc\.json

install: decrypt
	stow --target=$(HOME) $(foreach regex,$(IGNORE_REGEXS),--ignore='$(regex)') -v -R $(STOW_DIRS)

uninstall:
	stow --target=$(HOME) $(foreach regex,$(IGNORE_REGEXS),--ignore='$(regex)') -v -D $(STOW_DIRS)

enc_files := $(wildcard pi/.pi/agent/*.enc.json)
decrypted_files := $(patsubst %.enc.json,%.json,$(enc_files))

$(decrypted_files): %.json: %.enc.json
	sops decrypt --output $@ $<

decrypt: $(decrypted_files)

skills:
	npx skills add ./skills/ --skills '*' -y -g
