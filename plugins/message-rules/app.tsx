import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { registerMessageRules } from "./ui/registration.tsx";
import "./app.css";

export default definePluginApp(registerMessageRules);
