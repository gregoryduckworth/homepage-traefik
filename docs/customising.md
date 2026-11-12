# Customising the page

- **Names and icons:** open a route's details and select **Change settings**. An icon is any `http://` or `https://` image address, for example from [Dashboard Icons](https://github.com/homarr-labs/dashboard-icons). Without one, the homepage uses the site's own icon (its SVG icon, `apple-touch-icon` or favicon, looked up from the server), or else the name's first letter.
- **Health checks:** in the same dialog, a route can be checked on another path, count only some status codes as up, or not be checked at all. See [Changing how a route is checked](./health-checks#changing-how-a-route-is-checked).
- **Hiding:** select **Hide route** in its details. Hidden routes are left off the page and the status strip. **Show hidden routes** brings them back into view.
- **Groups:** select **New group**, then drag routes onto it, or pick it from the **Group** menu in a route's details. Reorder groups by dragging their headings or with the arrow buttons beside their names, and routes within a group by dragging them or with **Move up** and **Move down** in their details. The menu and buttons work with a keyboard and on phones. Routes in no group are listed by name. Deleting a group sends its routes back to their entry point groups.
- Press `/` to search by name, address, service or rule. The page has light and dark themes, and updates by itself when anything changes.

Anyone who can open the homepage can change these settings, unless it's [read-only](#sharing-the-page-read-only). Put authentication middleware in front of it in Traefik if that matters to you.

## Sharing the page read-only

To let people see the page without letting them change it, say in a shared house where one person arranges it, set `READ_ONLY=true`. The page then has no **New group** button, no buttons beside group names and no dragging, and a route's details have no **Group** menu, **Move up** or **Move down**, **Change settings** or **Hide route**. The server refuses any change with a `403`, so the settings can't be changed by calling the API directly either. Everyone can still search, show hidden routes on their own screen and select **Check now**, which checks a route without saving anything.

To change the layout of a read-only homepage, either edit `homepage.json` by hand (see [Saved settings](./saved-settings)), or run a second, editable homepage on the same config folder behind authentication middleware:

```yaml
services:
  homepage:
    image: ghcr.io/gregoryduckworth/homepage-traefik:latest
    environment:
      READ_ONLY: "true"
    volumes:
      - ./config:/app/config
    labels:
      - traefik.enable=true
      - traefik.http.routers.homepage.rule=Host(`home.example.com`)
      - traefik.http.services.homepage.loadbalancer.server.port=3000

  homepage-editor:
    image: ghcr.io/gregoryduckworth/homepage-traefik:latest
    volumes:
      - ./config:/app/config
    labels:
      - traefik.enable=true
      - traefik.http.routers.homepage-editor.rule=Host(`home-edit.example.com`)
      - traefik.http.routers.homepage-editor.middlewares=my-auth@file
      - traefik.http.services.homepage-editor.loadbalancer.server.port=3000
```

Changes saved on the editable one show up on the read-only one within 30 seconds. Each still reads routes from Traefik and checks them on its own.

