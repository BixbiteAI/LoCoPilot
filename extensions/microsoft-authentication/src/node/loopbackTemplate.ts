/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
export const loopbackTemplate = `
<!DOCTYPE html>
<html lang="en">

<head>
	<meta charset="utf-8" />
	<title>Microsoft Account - Sign In</title>
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<style>
		html {
			height: 100%;
		}

		body {
			box-sizing: border-box;
			min-height: 100%;
			margin: 0;
			padding: 15px 30px;
			display: flex;
			flex-direction: column;
			color: white;
			font-family: "Segoe UI","Helvetica Neue","Helvetica",Arial,sans-serif;
			background-color: #2C2C32;
		}

		.branding {
			background-image: url('data:image/svg+xml;base64,PHN2ZyBpZD0iTGF5ZXJfMSIgZGF0YS1uYW1lPSJMYXllciAxIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyMDAwIDIwMDAiPjxkZWZzPjxzdHlsZT4uY2xzLTF7ZmlsbDojZmZmO308L3N0eWxlPjwvZGVmcz48cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik0xMjE1LjEyLDE2OTEuMjhhMjMxLjk0LDIzMS45NCwwLDAsMC01MS0yNTEuNDdsLTc1LjUxLTc1LjUtNDMsNDMsNzUuNSw3NS41YzY2Ljc3LDY2Ljc3LDY2Ljc3LDE3NS40MiwwLDI0Mi4xOWExNzEuMjUsMTcxLjI1LDAsMSwxLTI0Mi4xOC0yNDIuMThMOTU0LDE0MDcuNzVsLTQzLTQzLjEzLTc1LjIsNzUuMmEyMzIuMTMsMjMyLjEzLDAsMSwwLDM3OS4yNiwyNTEuNDZaTTkyNy44LDEzNDcuODhsNDMsNDMuMTMsMjkuMjMtMjkuMjMsMjguODUsMjguODQsNDMtNDMtMjguODQtMjguODRMMTIwNy43NywxMTU0bC00My00M0wxMDAwLDEyNzUuNjgsODM2LjE1LDExMTEuODNsLTQzLDQzLjA1TDk1NywxMzE4LjczWiIvPjxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTcyNC4zMiwxMDAwLDg4OC4xOCw4MzYuMTVsLTQzLTQzTDY4MS4yOCw5NTcsNjUxLjUsOTI3LjE3bC00My4xNCw0M0w2MzguMjMsMTAwMGwtMjguODQsMjguODQsNDMsNDMuMDUsMjguODUtMjguODRMODQ2LDEyMDcuNzZsNDMtNDNaTTUxNy4xNCwxMTIxLjA5Yy02Ni43Nyw2Ni43Ny0xNzUuNDEsNjYuNzctMjQyLjE3LDBBMTcxLjI0LDE3MS4yNCwwLDAsMSw1MTcuMTQsODc4LjkybDc0LjQ5LDc0LjQ4LDQzLjEzLTQzLTc0LjU3LTc0LjU2YTIzMi4yNSwyMzIuMjUsMCwxLDAsMCwzMjguMjdsNzUuNTEtNzUuNTEtNDMtNDMuMDVaIi8+PHBhdGggY2xhc3M9ImNscy0xIiBkPSJNMTA0Myw2ODEuMjhsMjkuNzktMjkuNzktNDMtNDMuMTJMMTAwMCw2MzguMjNsLTI5LjQ3LTI5LjQ2LTQzLDQzTDk1Nyw2ODEuMjgsNzkyLjIzLDg0Nmw0Myw0M0wxMDAwLDcyNC4zM2wxNjMuODUsMTYzLjg1LDQzLjA1LTQzWm0xNzIuMDgtMTk3Ljg5QTIzMi4yMywyMzIuMjMsMCwxLDAsODM1Ljg2LDU2MC4ybDc0Ljg4LDc0Ljg3LDQzLTQzLTc0Ljg4LTc0Ljg4YTE3MS4yOCwxNzEuMjgsMCwwLDEsMC0yNDIuMTljNjYuNzYtNjYuNzYsMTc1LjQxLTY2Ljc2LDI0Mi4xOCwwYTE3MS40NSwxNzEuNDUsMCwwLDEsMCwyNDIuMTdsLTc0LjQ5LDc0LjQ5LDQzLDQzLjEyLDc0LjU3LTc0LjU2QTIzMC43OCwyMzAuNzgsMCwwLDAsMTIxNS4xMiw0ODMuMzlaIi8+PHBhdGggY2xhc3M9ImNscy0xIiBkPSJNMTM2MS43NywxMDAwbDI5LjQ4LTI5LjQ4LTQzLjA2LTQzTDEzMTguNzIsOTU3LDExNTQsNzkyLjI0bC00Myw0M0wxMjc1LjY3LDEwMDBsLTE2My44NSwxNjMuODUsNDMsNDMuMDYsMTYzLjg1LTE2My44NSwyOS4xNiwyOS4xNSw0My4xMi00M1ptNDU3LjMsODcuMzNhMjMyLjExLDIzMi4xMSwwLDAsMC0zNzkuMjUtMjUxLjQ3bC03NC44OSw3NC44Nyw0My4wNiw0Myw3NC44Ny03NC44N2ExNzEuMjQsMTcxLjI0LDAsMSwxLDAsMjQyLjE3bC03NS4xMS03NS4xLTQzLjEyLDQzLDc1LjE4LDc1LjE4YTIzMi4yMywyMzIuMjMsMCwwLDAsMzc5LjI2LTc2LjhaIi8+PHBhdGggY2xhc3M9ImNscy0xIiBkPSJNMTIzNy44NCwxMTgyLjI0bC01NS41OCw1NS41OCw1NS42OC01NS40OFoiLz48cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik03NjIuMTgsMTE4Mi4yNmw1NS40OCw1NS42OC4xLS4xWiIvPjxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTc2Mi4wNSw4MTcuNjZsLjExLjEsNTQtNTRaIi8+PHBhdGggY2xhc3M9ImNscy0xIiBkPSJNMTA5Mi4yNCwxNTEzLjU3bC03Ni03Ni4yN0wxMTk5LDEyNTQuNTlsMTY1LjY1LTE2NSw0My4xMy00MywyOS41My0yOS40Miw3Ni4yOSw3Ni4yOWExMzEuMzEsMTMxLjMxLDAsMSwwLDAtMTg1LjczbC03Ni4yNyw3NkwxMjUzLjQ5LDc5OS45MiwxMDg5LjU3LDYzNS4zN2wtNDMtNDMuMTItMjkuNC0yOS41Myw3Ni4yOS03Ni4yOGM1MS4yLTUxLjE5LDUxLjItMTM0LjUyLDAtMTg1Ljcxcy0xMzQuNTEtNTEuMTktMTg1LjcxLDBhMTMxLjMxLDEzMS4zMSwwLDAsMCwwLDE4NS42OWw3Niw3Ni4yN0w3OTkuNDYsNzQ3LDYzNC43NSw5MTEuMDZsLTQzLjEzLDQzLTI4Ljg5LDI4Ljc5LTc2LjI5LTc2LjI5YTEzMS4zMiwxMzEuMzIsMCwwLDAtMTg1LjcxLDE4NS43MWM1MS4yLDUxLjIsMTM0LjUsNTEuMiwxODUuNjksMGw3Ni4yOC03Nkw3NDUuNDEsMTE5OWwxNjUuNjUsMTY2LjI3LDQzLDQzLjEzLDI4Ljc5LDI4LjktNzYuMjksNzYuMjljLTUxLjIsNTEuMi01MS4yLDEzNC41MSwwLDE4NS43MXMxMzQuNTEsNTEuMiwxODUuNzEsMFMxMTQzLjQzLDE1NjQuNzYsMTA5Mi4yNCwxNTEzLjU3Wk0xNTMwLjMsOTI0LjUxYTEwNy42NCwxMDcuNjQsMCwxLDEsMCwxNTIuMjNMMTQ1NCwxMDAwLjQ4Wm0tMTA2MC42LDE1MWExMDcuNjQsMTA3LjY0LDAsMSwxLDAtMTUyLjIyTDU0Niw5OTkuNTFaTTEwMDAuNDgsNTQ2bC03Ni03Ni4yNWExMDcuNjUsMTA3LjY1LDAsMSwxLDE1Mi4yMywwWk0xMzkxLDEwMjkuODZsLTQzLjEzLDQzLTEwOS45MywxMDkuNTEtNTUuNjgsNTUuNDhMOTk5LjU1LDE0MjAuNTNsLTI4Ljc5LTI4Ljg5LTQzLTQzLjE0TDgxNy42NiwxMjM3Ljk0bC01NS40OC01NS42OEw1NzkuNDcsOTk5LjU1bDI4Ljg5LTI4Ljc5LDQzLjEzLTQzTDc2Mi4wNSw4MTcuNjZsNTQuMTItNTMuOTIsMTg0LjI4LTE4NC4yOEwxMDI5Ljg2LDYwOWw0Myw0My4xMiwxMDkuNTIsMTA5Ljk1LDU0LjM2LDU0LjU2LDE4My44MiwxODMuODJaTTkyMy4yNSwxNjgyLjUzYTEwNy43OCwxMDcuNzgsMCwwLDEsMC0xNTIuMjNMOTk5LjUyLDE0NTRsNzYsNzYuMjZhMTA3LjY1LDEwNy42NSwwLDEsMS0xNTIuMjUsMTUyLjIzWiIvPjxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTExODIuMzUsNzYyLjA2bC0uMS4xLDU0LjQ2LDU0LjQ2WiIvPjwvc3ZnPg==');
			background-size: 24px;
			background-repeat: no-repeat;
			background-position: left center;
			padding-left: 36px;
			font-size: 20px;
			letter-spacing: -0.04rem;
			font-weight: 400;
			color: white;
			text-decoration: none;
		}

		.message-container {
			flex-grow: 1;
			display: flex;
			align-items: center;
			justify-content: center;
			margin: 0 30px;
		}

		.message {
			font-weight: 300;
			font-size: 1.4rem;
		}

		body.error .message {
			display: none;
		}

		body.error .error-message {
			display: block;
		}

		.error-message {
			display: none;
			max-width: 800px;
			font-weight: 300;
			font-size: 1.3rem;
		}

		.error-text {
			color: salmon;
			font-size: 1rem;
		}

		@font-face {
			font-family: 'Segoe UI';
			src: url("https://c.s-microsoft.com/static/fonts/segoe-ui/west-european/light/latest.eot"),url("https://c.s-microsoft.com/static/fonts/segoe-ui/west-european/light/latest.eot?#iefix") format("embedded-opentype");
			src: local("Segoe UI Light"),url("https://c.s-microsoft.com/static/fonts/segoe-ui/west-european/light/latest.woff2") format("woff2"),url("https://c.s-microsoft.com/static/fonts/segoe-ui/west-european/light/latest.woff") format("woff"),url("https://c.s-microsoft.com/static/fonts/segoe-ui/west-european/light/latest.ttf") format("truetype"),url("https://c.s-microsoft.com/static/fonts/segoe-ui/west-european/light/latest.svg#web") format("svg");
			font-weight: 200
		}

		@font-face {
			font-family: 'Segoe UI';
			src: url("https://c.s-microsoft.com/static/fonts/segoe-ui/west-european/semilight/latest.eot"),url("https://c.s-microsoft.com/static/fonts/segoe-ui/west-european/semilight/latest.eot?#iefix") format("embedded-opentype");
			src: local("Segoe UI Semilight"),url("https://c.s-microsoft.com/static/fonts/segoe-ui/west-european/semilight/latest.woff2") format("woff2"),url("https://c.s-microsoft.com/static/fonts/segoe-ui/west-european/semilight/latest.woff") format("woff"),url("https://c.s-microsoft.com/static/fonts/segoe-ui/west-european/semilight/latest.ttf") format("truetype"),url("https://c.s-microsoft.com/static/fonts/segoe-ui/west-european/semilight/latest.svg#web") format("svg");
			font-weight: 300
		}

		@font-face {
			font-family: 'Segoe UI';
			src: url("https://c.s-microsoft.com/static/fonts/segoe-ui/west-european/normal/latest.eot"),url("https://c.s-microsoft.com/static/fonts/segoe-ui/west-european/normal/latest.eot?#iefix") format("embedded-opentype");
			src: local("Segoe UI"),url("https://c.s-microsoft.com/static/fonts/segoe-ui/west-european/normal/latest.woff2") format("woff"),url("https://c.s-microsoft.com/static/fonts/segoe-ui/west-european/normal/latest.woff") format("woff"),url("https://c.s-microsoft.com/static/fonts/segoe-ui/west-european/normal/latest.ttf") format("truetype"),url("https://c.s-microsoft.com/static/fonts/segoe-ui/west-european/normal/latest.svg#web") format("svg");
			font-weight: 400
		}

		@font-face {
			font-family: 'Segoe UI';
			src: url("https://c.s-microsoft.com/static/fonts/segoe-ui/west-european/semibold/latest.eot"),url("https://c.s-microsoft.com/static/fonts/segoe-ui/west-european/semibold/latest.eot?#iefix") format("embedded-opentype");
			src: local("Segoe UI Semibold"),url("https://c.s-microsoft.com/static/fonts/segoe-ui/west-european/semibold/latest.woff2") format("woff"),url("https://c.s-microsoft.com/static/fonts/segoe-ui/west-european/semibold/latest.woff") format("woff"),url("https://c.s-microsoft.com/static/fonts/segoe-ui/west-european/semibold/latest.ttf") format("truetype"),url("https://c.s-microsoft.com/static/fonts/segoe-ui/west-european/semibold/latest.svg#web") format("svg");
			font-weight: 600
		}

		@font-face {
			font-family: 'Segoe UI';
			src: url("https://c.s-microsoft.com/static/fonts/segoe-ui/west-european/bold/latest.eot"),url("https://c.s-microsoft.com/static/fonts/segoe-ui/west-european/bold/latest.eot?#iefix") format("embedded-opentype");
			src: local("Segoe UI Bold"),url("https://c.s-microsoft.com/static/fonts/segoe-ui/west-european/bold/latest.woff2") format("woff"),url("https://c.s-microsoft.com/static/fonts/segoe-ui/west-european/bold/latest.woff") format("woff"),url("https://c.s-microsoft.com/static/fonts/segoe-ui/west-european/bold/latest.ttf") format("truetype"),url("https://c.s-microsoft.com/static/fonts/segoe-ui/west-european/bold/latest.svg#web") format("svg");
			font-weight: 700
		}
	</style>
</head>

<body>
	<a class="branding" href="https://code.visualstudio.com/">
		Visual Studio Code
	</a>
	<div class="message-container">
		<div class="message">
			You are signed in now and can close this page.
		</div>
		<div class="error-message">
			An error occurred while signing in:
			<div class="error-text"></div>
		</div>
	</div>
	<script>
		var search = new URLSearchParams(window.location.search);
		var error = search.get('error');
		if (error) {
			const description = search.get('error_description');
			document.querySelector('.error-text')
				.textContent = error + ' - ' + description;
			document.querySelector('body')
				.classList.add('error');
		}
	</script>
</body>

</html>
`;
