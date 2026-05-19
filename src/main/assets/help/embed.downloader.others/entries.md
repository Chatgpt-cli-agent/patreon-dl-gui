## Custom embed downloader

---

Configure your own embed downloaders to download embedded videos from providers not covered by `patreon-dl`.

Each embed downloader has two components: provider and command. When `patreon-dl` comes across embedded content from a matching provider, it will run the corresponding command to download it.

##### Provider

The name of the provider.

To find out the name of a provider, download a single post containing the embedded video. Navigate to the directory of the downloaded post. Then, under the `embed` subdirectory, open the `embedded-video.txt` file to obtain the provider's name.

##### Command

The command to download the embedded video.

Fields enclosed in curly braces will be replaced with actual values at runtime. Available fields:

| Field                | Description                                                     |
| -------------------- | --------------------------------------------------------------- |
| `post.id`            | ID of the post containing the embedded video.                   |
| `post.url`           | URL of the post containing the embeded video.                   |
| `embed.provider`     | Name of the provider, i.e. "SproutVideo".                       |
| `embed.provider.url` | Link to the provider's site.                                    |
| `embed.url`          | Link to the video page supplied by the provider.                |
| `embed.subject`      | Subject of the video.                                           |
| `embed.html`         | The HTML code that embeds the video player on the Patreon page. |
| `cookie`             | The cookie used by `patreon-dl` to fetch Patreon content.       |
| `dest.dir`           | The directory where the video should be saved.                  |

##### Note about external downloaders

External downloaders are not subject to "Max retries" (under Other -> Network requests tab) and "File exists action" (under Output tab) settings. This is because `patreon-dl` has no control over the downloading process nor knowledge about the outcome of it (including where and under what name the file was saved).

Also note that external downloaders are not executed when "Dry run" is enabled. This is because `patreon-dl` does not create directories in dry-run and external downloaders might throw an error as they try to write in non-existent directories.

Although care is taken to ensure command arguments are properly escaped, you should be aware of the risks involved in running external programs with arguments having arbitrary values (as you will see, certain embed properties can be passed as arguments). You should always quote strings.
