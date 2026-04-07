WASM_PKG := wasm_pkg

.PHONY: wasm clean

wasm:
	wasm-pack build wasm/ --target web --out-dir ../$(WASM_PKG) --release
	@echo "WASM built → $(WASM_PKG)/"

clean:
	rm -rf $(WASM_PKG) wasm/target
