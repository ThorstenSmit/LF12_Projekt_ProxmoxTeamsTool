import { BrowserRouter, Routes, Route } from "react-router-dom";
import { TeamsAuthProvider } from "./auth/TeamsAuthProvider";
import { Layout } from "./components/Layout";
import { HomePage } from "./pages/HomePage";
import { MyVMsPage } from "./pages/MyVMsPage";
import { TemplatesPage } from "./pages/TemplatesPage";
import { ClassesPage } from "./pages/ClassesPage";
import { AdminPage } from "./pages/AdminPage";
import { ConsolePage } from "./pages/ConsolePage";
import "./App.css";

function App() {
  return (
    <TeamsAuthProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<HomePage />} />
            <Route path="my-vms" element={<MyVMsPage />} />
            <Route path="vms/:vmid/console" element={<ConsolePage />} />
            <Route path="templates" element={<TemplatesPage />} />
            <Route path="classes" element={<ClassesPage />} />
            <Route path="admin" element={<AdminPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </TeamsAuthProvider>
  );
}

export default App;
