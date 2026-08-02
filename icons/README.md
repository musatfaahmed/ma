# Panel Icons

Adobe CEP will **refuse to register a panel** if an `<Icon>` declared in
`CSXS/manifest.xml` points at a file that does not exist. For that reason the
`<Icons>` block is currently commented out in the manifest.

## Re-enabling icons

1. Drop these five 23×23 PNG files into this folder:

| File                   | Used for                    |
|------------------------|-----------------------------|
| `iconNormal.png`       | Light theme, normal state   |
| `iconRollover.png`     | Light theme, mouse over     |
| `iconDisabled.png`     | Disabled state              |
| `iconDarkNormal.png`   | Dark theme, normal state    |
| `iconDarkRollover.png` | Dark theme, mouse over      |

2. Un-comment the `<Icons>` block inside the `<UI>` element in
   `CSXS/manifest.xml`:

```xml
<Icons>
    <Icon Type="Normal">./icons/iconNormal.png</Icon>
    <Icon Type="RollOver">./icons/iconRollover.png</Icon>
    <Icon Type="Disabled">./icons/iconDisabled.png</Icon>
    <Icon Type="DarkNormal">./icons/iconDarkNormal.png</Icon>
    <Icon Type="DarkRollOver">./icons/iconDarkRollover.png</Icon>
</Icons>
```

Icons are **optional** — the panel loads and works perfectly without them.
