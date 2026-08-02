# Images

Static image assets for the panel UI.

The current interface is rendered entirely with CSS and Unicode glyphs
(see `css/style.css`), so no raster assets are required for the extension
to load or function.

Any images added here can be referenced from `index.html` with a relative
path, for example:

```html
<img src="images/my-asset.png" alt="">
```

Keep assets small — CEP panels load them from the local filesystem on every
panel open.
